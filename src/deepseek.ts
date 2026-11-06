/**
 * DeepSeek web-chat client (chat.deepseek.com).
 *
 * Reuses the logged-in session of the web app: the token from the browser's
 * live `Authorization: Bearer` header. Optionally replays captured browser
 * headers/cookie for fingerprint parity.
 *
 * Protocol reference (Nov 2026): deepseek-free-api forks, deepseek-web2api-free.
 *   POST /api/v0/chat/create_pow_challenge   -> PoW challenge (per target path)
 *   POST /api/v0/chat_session/create         -> new chat session (needs PoW)
 *   POST /api/v0/chat/completion             -> SSE chat stream (needs PoW)
 */
import { solvePoW, type PoWChallenge } from "./pow.ts"

export interface DeepSeekOptions {
  token: string
  userAgent?: string
  clientVersion?: string
  /** Additional headers captured from the real browser request (import). */
  browserHeaders?: Record<string, string>
  /** Cookie header string captured from the browser (jar seeding). */
  cookie?: string
  log?: (msg: string) => void
}

export interface CompletionChunk {
  type: "thinking" | "content"
  text: string
}

export interface CompletionOpts {
  chatSessionId: string
  thinking?: boolean
  search?: boolean
  temperature?: number
  topP?: number
  maxTokens?: number
  signal?: AbortSignal
}

export class DeepSeekError extends Error {
  status: number
  body: string
  constructor(status: number, body: string, message?: string) {
    super(message ?? `DeepSeek returned HTTP ${status}: ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}

export class DeepSeekAuthError extends DeepSeekError {
  constructor(status: number, body: string, message?: string) {
    super(
      status,
      body,
      message ??
        "DeepSeek rejected the session token (INVALID_TOKEN). The userToken cookie may not be the live credential anymore. Capture the real one: DevTools (F12) → Network → filter 'completion' → copy the POST /api/v0/chat/completion request as cURL → run `python3 scripts/import-curl-token.py <curl.txt> --write` (make sure you were logged in when the request was made).",
    )
    this.name = "DeepSeekAuthError"
  }
}

const DS_BASE = "https://chat.deepseek.com"

/** Default web-client headers (parity with deepseek-web2api-free, 2026-08). */
const DEFAULT_HEADERS: Record<string, string> = {
  "accept": "*/*",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "content-type": "application/json",
  "origin": DS_BASE,
  "referer": `${DS_BASE}/`,
  "priority": "u=1, i",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-client-version": "2.4.2",
  "x-client-platform": "web",
  "x-client-locale": "zh_CN",
  "x-client-bundle-id": "com.deepseek.chat",
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** Best-effort x-hif-leim / x-hif-dliq signature headers (600s TTL cache). */
class HifProvider {
  private cache = new Map<string, { value: string; until: number }>()
  private cookie?: string
  constructor(cookie?: string) {
    this.cookie = cookie
  }

  private async fetch(url: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const headers: Record<string, string> = { accept: "*/*" }
      if (this.cookie) headers["cookie"] = this.cookie
      const res = await fetch(url, { headers, signal })
      if (!res.ok) return null
      const ttl = Number(res.headers.get("x-hif-ttl") ?? 600) || 600
      const value = (await res.json())?.data?.biz_data?.value
      if (!value) return null
      this.cache.set(url, { value: String(value), until: Date.now() + Math.max(ttl, 1) * 1000 })
      return this.cache.get(url)!.value
    } catch {
      return null
    }
  }

  private async get(url: string, signal?: AbortSignal): Promise<string | null> {
    const hit = this.cache.get(url)
    if (hit && hit.until > Date.now()) return hit.value
    return this.fetch(url, signal)
  }

  async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const leim = await this.get("https://hif-leim.deepseek.com/query", signal)
    if (leim) out["x-hif-leim"] = leim
    const dliq = await this.get("https://hif-dliq.deepseek.com/query", signal)
    if (dliq) out["x-hif-dliq"] = dliq
    return out
  }
}

export class DeepSeekClient {
  private token: string
  private browserHeaders: Record<string, string>
  private log: (msg: string) => void
  private hif: HifProvider

  constructor(opts: DeepSeekOptions) {
    this.token = opts.token
    this.browserHeaders = opts.browserHeaders ?? {}
    this.log = opts.log ?? (() => {})
    this.hif = new HifProvider(opts.cookie)
  }

  private async headers(targetSessionId?: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...DEFAULT_HEADERS, ...this.browserHeaders }
    h["user-agent"] ??= DEFAULT_UA
    if (targetSessionId) h["referer"] = `${DS_BASE}/a/chat/s/${targetSessionId}`
    h["authorization"] = `Bearer ${this.token}`
    // Merge browser head fingerprints, then hif signatures on top.
    for (const [k, v] of Object.entries(await this.hif.headers(signal))) h[k.toLowerCase()] = v
    return h
  }

  private async request(path: string, body: unknown, signal?: AbortSignal) {
    try {
      return await fetch(DS_BASE + path, {
        method: "POST",
        headers: await this.headers(undefined, signal),
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e
      throw new Error(`DeepSeek request failed: ${(e as Error)?.message ?? e}`)
    }
  }

  /** Fetch + solve a PoW challenge for a target path. */
  async getPoW(targetPath: string, signal?: AbortSignal): Promise<string> {
    const res = await this.request("/api/v0/chat/create_pow_challenge", { target_path: targetPath }, signal)
    const text = await res.text()
    if (!res.ok) throw new DeepSeekError(res.status, text)
    const data = JSON.parse(text)
    const challenge: PoWChallenge | undefined = data?.data?.biz_data?.challenge
    if (!challenge?.challenge) {
      const code = data?.code
      if (code === 40003) throw new DeepSeekAuthError(res.status, text)
      throw new DeepSeekError(res.status, text, `No PoW challenge in response: ${JSON.stringify(data).slice(0, 300)}`)
    }
    const { answer, response } = await solvePoW(challenge)
    this.log(`PoW solved: nonce=${answer} difficulty=${challenge.difficulty}`)
    return response
  }

  /** Create a fresh web-app chat session and return its id. */
  async createSession(signal?: AbortSignal): Promise<string> {
    // 2026 protocol: session create itself carries a PoW for chat/completion.
    const pow = await this.getPoW("/api/v0/chat/completion", signal)
    const headers = await this.headers(undefined, signal)
    headers["x-ds-pow-response"] = pow

    const res = await fetch(DS_BASE + "/api/v0/chat_session/create", {
      method: "POST",
      headers,
      body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
      signal,
    })
    const text = await res.text()
    if (res.status === 401) throw new DeepSeekAuthError(401, text)
    if (res.status === 403 && /waf|captcha/i.test(text)) {
      throw new DeepSeekError(res.status, text, "DeepSeek WAF blocked the request (HTTP 403). Retry later, or import a fresh cURL and set the plugin's user-agent to your real browser UA.")
    }
    if (!res.ok) throw new DeepSeekError(res.status, text)
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new DeepSeekError(res.status, text, "DeepSeek returned a non-JSON response (possibly a WAF challenge).")
    }
    if (data?.code != null && data.code !== 0) {
      throw this.bizError(res.status, text, data)
    }
    const biz = data?.data?.biz_data ?? {}
    const id = biz?.chat_session?.id ?? biz?.id
    if (!id) throw new DeepSeekError(res.status, text, `No chat session id in response: ${JSON.stringify(data).slice(0, 300)}`)
    return String(id)
  }

  private bizError(status: number, text: string, data: any): DeepSeekError {
    const code = data?.code
    const bizCode = data?.data?.biz_code
    const bizMsg = data?.data?.biz_msg ?? data?.msg ?? ""
    if (code === 40003) return new DeepSeekAuthError(status, text)
    if (bizCode === 5 || /mute/i.test(String(bizMsg))) {
      return new DeepSeekError(status, text, `DeepSeek signaled your account as muted (biz_code 5: ${bizMsg}). This is an account-level penalty, not a bridge problem.`)
    }
    return new DeepSeekError(
      status,
      text,
      `DeepSeek business error code=${code ?? "?"} biz_code=${bizCode ?? "?"}: ${bizMsg}`,
    )
  }

  /**
   * Stream a DeepSeek completion as an async generator of normalized chunks.
   */
  async *completion(prompt: string, opts: CompletionOpts): AsyncGenerator<CompletionChunk> {
    const pow = await this.getPoW("/api/v0/chat/completion", opts.signal)
    const headers = await this.headers(opts.chatSessionId, opts.signal)
    headers["x-ds-pow-response"] = pow

    const body: Record<string, unknown> = {
      chat_session_id: opts.chatSessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: opts.thinking ?? false,
      search_enabled: opts.search ?? false,
    }
    if (opts.temperature != null) body["temperature"] = opts.temperature
    if (opts.topP != null) body["top_p"] = opts.topP
    if (opts.maxTokens != null) body["max_tokens"] = opts.maxTokens

    const res = await fetch(DS_BASE + "/api/v0/chat/completion", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    const errText = res.ok ? "" : await res.text().catch(() => "")
    if (!res.ok) {
      throw res.status === 401
        ? new DeepSeekAuthError(401, errText)
        : new DeepSeekError(res.status, errText)
    }
    if (!res.body) throw new DeepSeekError(res.status, "", "DeepSeek completion stream is empty")

    const contentType = res.headers.get("content-type") ?? ""
    try {
      for await (const chunk of parseSSE(res.body, opts.thinking ?? false, this.log, contentType)) {
        yield chunk
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? "")
      if (msg.startsWith("BIZ:")) {
        const raw = msg.slice(4)
        let data: any
        try {
          data = JSON.parse(raw)
        } catch {
          data = null
        }
        throw data ? this.bizError(200, raw, data) : e
      }
      throw e
    }
  }
}

/**
 * Parse the full completion HTTP body (DeepSeek streams the whole SSE inside
 * one body for fetch(); kept as one text for simpler error detection).
 * Exported for tests.
 */
export function parseCompletionResponse(
  body: string,
  thinkingEnabled: boolean,
  log: (msg: string) => void,
): AsyncGenerator<CompletionChunk> {
  return parseSSE(streamOf(body), thinkingEnabled, log)
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      // Feed in a few pieces so multi-chunk buffering paths are exercised.
      const size = Math.max(1, Math.ceil(text.length / 3))
      for (let i = 0; i < text.length; i += size) {
        controller.enqueue(enc.encode(text.slice(i, i + size)))
      }
      controller.close()
    },
  })
}

/** Parse DeepSeek's internal SSE format into normalized chunks. */
async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  thinkingEnabled: boolean,
  log: (msg: string) => void,
  contentType = "",
): AsyncGenerator<CompletionChunk> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  let fragmentType: string | null = null
  let phase: "content" | "thinking" = "content"
  let sawSSEdata = false
  let jsonOnly = /application\/json/i.test(contentType || "")

  const emit = function* (fragment: string): Generator<CompletionChunk> {
    for (const line of fragment.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === "[DONE]") continue

      let obj: any
      try {
        obj = JSON.parse(payload)
      } catch {
        continue
      }

      const val = obj.v

      if (val != null && typeof val === "object" && !Array.isArray(val)) {
        // New-format metadata: {"v": {"response": {"fragments": [...]}}}
        const resp = val.response
        if (resp != null && typeof resp === "object" && Array.isArray(resp.fragments)) {
          for (const frag of resp.fragments) {
            if (frag != null && typeof frag === "object") {
              if (frag.type) fragmentType = String(frag.type)
              const c = frag.content
              if (typeof c === "string" && c) {
                yield fragmentType === "THINK"
                  ? { type: "thinking", text: c }
                  : { type: "content", text: c }
              }
            }
          }
        }
        // Toast error: {"v": {"type": "error", "content": ..., "finish_reason": ...}}
        if (val.type === "error" && (val.content || val.finish_reason)) {
          throw new Error(`DeepSeek aborted the stream: ${val.content ?? val.finish_reason}`)
        }
        continue
      }

      const path: string = obj.p ?? ""

      // {"p":"response/fragments","o":"APPEND","v":[{type,content}]}
      if (path === "response/fragments" && obj.o === "APPEND" && Array.isArray(val)) {
        if (val.length) {
          const last = val[val.length - 1]
          if (last && typeof last === "object") {
            if (last.type) fragmentType = String(last.type)
            const c = last.content
            if (typeof c === "string" && c) {
              yield fragmentType === "THINK"
                ? { type: "thinking", text: c }
                : { type: "content", text: c }
            }
          }
        }
        continue
      }

      // {"p":"response/fragments/-1/content","v":"..."}
      if (path === "response/fragments/-1/content") {
        if (typeof val === "string" && val) {
          yield fragmentType === "THINK"
            ? { type: "thinking", text: val }
            : { type: "content", text: val }
        }
        continue
      }

      // Old format: {"p":"response/content",...} / {"p":"response/thinking_content",...}
      if (path === "response/content") {
        if ((obj.o == null || obj.o === "APPEND") && typeof val === "string" && val) {
          phase = "content"
          yield { type: "content", text: val }
        }
        continue
      }
      if (path === "response/thinking_content") {
        if ((obj.o == null || obj.o === "APPEND") && thinkingEnabled && typeof val === "string" && val) {
          phase = "thinking"
          yield { type: "thinking", text: val }
        }
        continue
      }
      if (path) continue // status / elapsed_secs / BATCH / toast metadata
      if (typeof val === "string" && val) {
        // Pathless continuation line: keep current phase/fragment type.
        const isThinking = fragmentType != null ? fragmentType === "THINK" : phase === "thinking"
        if (isThinking && thinkingEnabled) yield { type: "thinking", text: val }
        else yield { type: "content", text: val }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (!sawSSEdata) {
        // A business-error body (mute, throttling, PoW rejection) arrives as
        // plain JSON with HTTP 200 instead of SSE. Detect and surface it.
        if (jsonOnly || (!buffer.startsWith("data:") && buffer.trimStart().startsWith("{") && buffer.length > 12 && buffer.includes('"code"'))) {
          const candidate = buffer.trim()
          const looksComplete = candidate.length > 16 && candidate.endsWith("}")
          if (looksComplete) {
            try {
              const data = JSON.parse(candidate)
              throw new Error(`BIZ:${JSON.stringify(data).slice(0, 400)}`)
            } catch (e) {
              if (String((e as Error).message).startsWith("BIZ:")) throw e
              /* keep buffering — still a partial JSON */
            }
          }
        }
        if (buffer.includes("data:")) sawSSEdata = true
      }
      // SSE events are separated by blank lines; be tolerant with \r\n\r\n
      const parts = buffer.split(/\n\n+/)
      buffer = parts.pop() ?? ""
      for (const event of parts) {
        yield* emit(event)
      }
    }
    if (buffer.trim()) {
      try {
        for (const event of [buffer]) yield* emit(event)
      } catch {
        /* */
      }
    }
  } finally {
    reader.releaseLock()
  }
}
