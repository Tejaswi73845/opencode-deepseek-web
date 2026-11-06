/**
 * opencode-deepseek-web — use your DeepSeek *web chat* session in OpenCode.
 *
 * This plugin starts a small local bridge (127.0.0.1) that speaks the
 * OpenAI-compatible protocol on the outside and DeepSeek's web-chat protocol
 * on the inside, authenticated with the `userToken` cookie from your
 * logged-in browser session. It registers a `deepseek-web` provider pointing
 * at the bridge, so the models appear under `/models`.
 *
 * Options on the plugin entry in opencode.json(c):
 *   { "package": ".../opencode-deepseek-web",
 *     "options": { "token": "..." | "cookie": "userToken=...",
 *                  "tokenFile": "...", "port": 8178, "userAgent": "...",
 *                  "contextLimit": 262144, "outputLimit": 65536 } }
 *
 * Token resolution order:
 *   options.token > options.cookie > DEEPSEEK_WEB_TOKEN env > options.tokenFile >
 *   ~/.config/opencode/deepseek-web/token.json | token.txt | cookie.txt
 *
 * Accepted token values: the bare userToken, a full "userToken=<value>"
 * cookie header string, "Bearer <token>", or a path in the form
 * "path:/home/me/token.txt".
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DeepSeekClient } from "./deepseek.ts"
import { startBridge, DEFAULT_MODEL_SPECS } from "./bridge.ts"

interface PluginContext {
  options?: Record<string, unknown>
  provider: {
    transform: (cb: (editor: any) => void) => Promise<unknown>
    reload: () => Promise<void>
  }
  location?: { directory?: string }
}

const DEFAULT_PORT = 8178
const DEFAULT_CONTEXT_LIMIT = 262_144
const DEFAULT_OUTPUT_LIMIT = 65_536
const TOKEN_DIR = path.join("__XDG__", "opencode", "deepseek-web")

function xdgConfigDir(): string {
  return process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME.trim()
    : path.join(os.homedir(), ".config")
}

function readTokenFile(p: string): string | undefined {
  const full = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
  try {
    if (!fs.existsSync(full)) return undefined
    return fs.readFileSync(full, "utf8")
  } catch {
    return undefined
  }
}

/** Pull a DeepSeek userToken out of a possibly messy string. */
function parseTokenCandidate(raw: string): string | undefined {
  const text = raw.trim()
  if (!text) return undefined
  // Full cookie header string
  const cookieMatch = text.match(/(?:^|[;\s])userToken=([^;\s"']+)/i)
  if (cookieMatch) return cookieMatch[1]
  // "Bearer xyz" authorization header value
  const bearer = text.match(/^Bearer\s+(\S+)$/i)
  if (bearer) return bearer[1]
  // JSON content: {"token": "..."} / {"userToken": "..."} / {"cookie": "..."}
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      const candidate = parsed?.token ?? parsed?.userToken ?? parsed?.cookie
      if (typeof candidate === "string" && candidate.trim()) return parseTokenCandidate(candidate)
    } catch {
      /* not JSON — fall through */
    }
  }
  // "path:/some/file" pointer
  const pathMatch = text.match(/^(?:path|file):(.+)$/)
  if (pathMatch) {
    const fromFile = readTokenFile(pathMatch[1].trim())
    return fromFile ? parseTokenCandidate(fromFile) : undefined
  }
  // Bare opaque token
  if (!/\s/.test(text) && text.length >= 16) return text
  return undefined
}

function resolveToken(ctx: PluginContext): string | undefined {
  const options = ctx.options ?? {}
  const opt = (key: string): string | undefined => {
    const v = options[key]
    return typeof v === "string" && v.trim() ? v.trim() : undefined
  }

  const directSources = [
    opt("token"),
    opt("cookie"),
    process.env.DEEPSEEK_WEB_TOKEN,
    process.env.DEEPSEEK_USER_TOKEN,
  ]
  for (const source of directSources) {
    if (!source) continue
    const token = parseTokenCandidate(source)
    if (token) return token
  }

  const tokenFile = opt("tokenFile") ?? process.env.DEEPSEEK_WEB_TOKEN_FILE
  if (tokenFile) {
    const fromFile = readTokenFile(tokenFile)
    const token = fromFile ? parseTokenCandidate(fromFile) : undefined
    if (token) return token
  }

  const tokenDir = TOKEN_DIR.replace("__XDG__", xdgConfigDir())
  for (const name of ["token.json", "token.txt", "cookie.txt"]) {
    const fromFile = readTokenFile(path.join(tokenDir, name))
    const token = fromFile ? parseTokenCandidate(fromFile) : undefined
    if (token) return token
  }
  return undefined
}

export default {
  id: "deepseek-web",
  async setup(ctx: PluginContext) {
    const log = (msg: string) => console.log(`[deepseek-web] ${msg}`)

    const token = resolveToken(ctx)
    if (!token) {
      console.warn(
        [
          "[deepseek-web] No DeepSeek web token found — models will answer with setup instructions until one is provided.",
          "Get the live `authorization: Bearer` token: DevTools (F12) → Network → filter 'completion' →",
          "copy the POST /api/v0/chat/completion request as cURL, then run:",
          "  python3 <plugin>/scripts/import-curl-token.py <curl.txt> --write",
          "Then provide it in one of these ways:",
          `  1. file: ${TOKEN_DIR.replace("__XDG__", xdgConfigDir())}/token.json  ->  {"token": "..."}`,
          "  2. env var: DEEPSEEK_WEB_TOKEN",
          '  3. plugin options: { "options": { "token": "..." } }',
        ].join("\n"),
      )
    }

    const options = ctx.options ?? {}
    const numOpt = (key: string): number | undefined => {
      const v = options[key]
      if (typeof v === "number" && Number.isFinite(v)) return v
      const env = process.env[`DEEPSEEK_WEB_${key.toUpperCase()}`]
      const n = env ? Number(env) : NaN
      return Number.isFinite(n) && env ? n : undefined
    }
    const port = typeof options.port === "number" ? options.port : (numOpt("port") ?? DEFAULT_PORT)
    const contextLimit = numOpt("contextLimit") ?? DEFAULT_CONTEXT_LIMIT
    const outputLimit = numOpt("outputLimit") ?? DEFAULT_OUTPUT_LIMIT

    // When no token is available yet, use a stub client so the bridge comes
    // up and fails with pointing-to-setup errors instead of provider-less UX.
    const client = (token
      ? new DeepSeekClient({
          token,
          userAgent: typeof options.userAgent === "string" ? options.userAgent : undefined,
          log,
        })
      : {
          async createSession() {
            const NO_TOKEN = [
              "deepseek-web: no DeepSeek web token is configured.",
              "Grab the `userToken` cookie from chat.deepseek.com (DevTools > Application > Cookies)",
              `and save it to ${TOKEN_DIR.replace("__XDG__", xdgConfigDir())}/token.json as {"token": "..."}`,
              "or set the DEEPSEEK_WEB_TOKEN environment variable.",
            ].join("\n")
            throw Object.assign(new Error(NO_TOKEN), { status: 401 })
          },
        }) as DeepSeekClient

    let bridge: { port: number; close: () => Promise<void> }
    try {
      bridge = await startBridge(client, DEFAULT_MODEL_SPECS, { port, token, log })
    } catch {
      bridge = await startBridge(client, DEFAULT_MODEL_SPECS, { port: 0, token, log })
      log(`default port ${port} was unavailable; bridge uses random port ${bridge.port} instead`)
    }
    log(`bridge listening on http://127.0.0.1:${bridge.port}/v1 (provider: deepseek-web)`)

    const baseURL = `http://127.0.0.1:${bridge.port}/v1`

    const mkModel = (spec: { id: string; name: string }, reasoning: boolean) => ({
      id: spec.id,
      modelID: spec.id,
      providerID: "deepseek-web",
      name: spec.name,
      type: "chat",
      capabilities: {
        tools: true,
        input: ["text"],
        output: reasoning ? ["text", "reasoning"] : ["text"],
        temperature: true,
      },
      compatibility: reasoning ? { reasoningField: "reasoning_content" } : {},
      variants: [],
      time: { released: 0 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: contextLimit, output: outputLimit },
    })

    await ctx.provider.transform((editor: any) => {
      editor.add({
        info: {
          id: "deepseek-web",
          name: "DeepSeek Web",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL, apiKey: "deepseek-web" },
        },
        models: [
          mkModel(DEFAULT_MODEL_SPECS[0], false),
          mkModel(DEFAULT_MODEL_SPECS[1], true),
          mkModel(DEFAULT_MODEL_SPECS[2], false),
          mkModel(DEFAULT_MODEL_SPECS[3], true),
        ],
      })
    })

    return () => bridge.close()
  },
}
