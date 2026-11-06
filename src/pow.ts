/**
 * DeepSeek "Proof of Work" solver using DeepSeek's own `sha3_wasm_bg.wasm`.
 *
 * DeepSeek's web client ships its PoW hashing as WASM; the exact hash is NOT
 * a plain NIST sha3-256 over a concatenation (verified live: pure-hash nonces
 * are rejected with 40003/40301). Solving through the upstream WASM gives
 * byte-exact parity with the browser.
 *
 * The wasm exposes wasm-bindgen style exports:
 *   __wbindgen_export_0(len, align) -> ptr   (alloc)
 *   __wbindgen_add_to_stack_pointer(delta)
 *   wasm_solve(retptr, ch_ptr, ch_len, pfx_ptr, pfx_len, difficulty: f64)
 * Status (i32) at retptr; 0 = no solution; nonce (f64) at retptr+8.
 *
 * Solver protocol (2026, deepseek-free-api family / deepseek-web2api-free):
 *   POST /api/v0/chat/create_pow_challenge -> challenge
 *   prefix = `${salt}_${expire_at}_`
 *   header x-ds-pow-response = base64(JSON{algorithm, challenge, salt,
 *                                          answer, signature, target_path})
 */
import fs from "node:fs"
import path from "node:path"

export interface PoWChallenge {
  algorithm?: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
  target_path?: string
}

let cached: {
  wasmSolve: (
    retptr: number,
    chPtr: number,
    chLen: number,
    pfxPtr: number,
    pfxLen: number,
    difficulty: number,
  ) => void
  alloc: (len: number, align: number) => number
  addToStack: (delta: number) => number
  memory: { buffer: ArrayBuffer }
} | null = null

function loadWasmBytes(): Uint8Array {
  const candidates: string[] = []
  // Bun native import directory
  const metaDir = (import.meta as unknown as { dir?: string }).dir
  if (metaDir) candidates.push(path.join(metaDir, "sha3_wasm_bg.wasm"))
  // Node ESM via file URL
  try {
    const url = new URL("./sha3_wasm_bg.wasm", import.meta.url)
    if (url.protocol === "file:") candidates.push(url.pathname.split("//").join("/"))
  } catch {
    /* ignore */
  }
  const env = process.env.DEEPSEEK_WASM_PATH
  if (env) candidates.push(path.resolve(env))
  // Fallbacks for running tests from the project root
  candidates.push(path.resolve("src/sha3_wasm_bg.wasm"))
  candidates.push(path.resolve("sha3_wasm_bg.wasm"))
  candidates.push("/home/tejaswi/opencode-deepseek-web/src/sha3_wasm_bg.wasm")

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file))
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(
    "sha3_wasm_bg.wasm not found next to the plugin sources — required to solve DeepSeek PoW",
  )
}

async function ensureSolver() {
  if (cached) return cached
  const bytes = loadWasmBytes()
  const module = new WebAssembly.Module(bytes)
  const instance = new WebAssembly.Instance(module, {})
  const exports = instance.exports as unknown as {
    memory: { buffer: ArrayBuffer }
    wasm_solve: (
      retptr: number,
      chPtr: number,
      chLen: number,
      pfxPtr: number,
      pfxLen: number,
      difficulty: number,
    ) => void
    "__wbindgen_export_0": (len: number, align: number) => number
    "__wbindgen_add_to_stack_pointer": (delta: number) => number
  }
  cached = {
    wasmSolve: exports["wasm_solve"],
    alloc: exports["__wbindgen_export_0"],
    addToStack: exports["__wbindgen_add_to_stack_pointer"],
    memory: exports.memory,
  }
  return cached
}

function writeString(s: string): number {
  const solver = cached!
  const enc = new TextEncoder()
  const bytes = enc.encode(s)
  const ptr = solver.alloc(bytes.length, 1)
  const view = new Uint8Array(solver.memory.buffer)
  view.set(bytes, ptr)
  return ptr
}

/** Solve a challenge and return the ready base64 x-ds-pow-response value. */
export async function solvePoW(challenge: PoWChallenge): Promise<{ answer: number; response: string }> {
  const solver = await ensureSolver()

  const prefixStr = `${challenge.salt}_${challenge.expire_at}_`
  const retptr = solver.addToStack(-16)
  let answer = -1
  try {
    const chPtr = writeString(challenge.challenge)
    const pfxPtr = writeString(prefixStr)
    solver.wasmSolve(
      retptr,
      chPtr,
      challenge.challenge.length,
      pfxPtr,
      prefixStr.length,
      Number(challenge.difficulty),
    )
    const i32 = new Int32Array(solver.memory.buffer)
    const status = i32[retptr >> 2]
    if (status === 0) {
      throw new Error(
        `DeepSeek PoW: WASM solver found no solution (difficulty ${challenge.difficulty})`,
      )
    }
    const f64 = new Float64Array(solver.memory.buffer)
    answer = Math.floor(f64[(retptr + 8) >> 3])
  } finally {
    solver.addToStack(16)
  }
  if (answer < 0) throw new Error("DeepSeek PoW: unexpected negative nonce")

  const response = Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm ?? "DeepSeekHashV1",
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path ?? "/api/v0/chat/completion",
    }),
  ).toString("base64")

  return { answer, response }
}
