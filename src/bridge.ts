/**
 * Local OpenAI-compatible bridge.
 *
 * Exposes /v1/models and /v1/chat/completions on 127.0.0.1 so that
 * `@opencode/ai/providers/openai-compatible` (or any OpenAI SDK client) can
 * talk to the DeepSeek *web* backend using the user's browser session token.
 */
import http from "node:http"
import { DeepSeekClient, DeepSeekAuthError, DeepSeekError } from "./deepseek.ts"
import { buildPrompt } from "./prompt.ts"
import { parseDsmlToolCalls, sanitizeLeakedOutput } from "./dsml.ts"

export interface BridgeOptions {
  port: number
  token: string
  userAgent?: string
  log: (msg: string) => void
}

const MODEL_CAPABILITIES: Record<string, { thinking: boolean; search: boolean }> = {
  chat: { thinking: false, search: false },
  reasoner: { thinking: true, search: false },
  search: { thinking: false, search: true },
  "reasoner-search": { thinking: true, search: true },
}

export interface ModelSpec {
  id: string
  name: string
}

export const DEFAULT_MODEL_SPECS: ModelSpec[] = [
  { id: "chat", name: "DeepSeek Chat (web session)" },
  { id: "reasoner", name: "DeepSeek Reasoner (web session, thinking)" },
  { id: "search", name: "DeepSeek Search (web, web search)" },
  { id: "reasoner-search", name: "DeepSeek Reasoner (web, thinking + search)" },
]

export function normalizeModelID(model: string | undefined): { model: string; thinking: boolean; search: boolean } {
  let m = (model ?? "chat").trim()
  // Tolerate "deepseek-web/chat" style ids arriving from the OpenAI SDK.
  m = m.split("/").pop()!
    .replace(/^deepseek-(?:web-)?/, "")
    .replace(/_search$/, "-search")
    .trim()
  if (m === "" || m === "default" || m === "flash" || m.startsWith("v3") || m.startsWith("v4")) m = "chat"
  const thinking = /reasoner/.test(m)
  const search = /search/.test(m)
  if (m === "chat" || m === "reasoner" || m === "search" || m === "reasoner-search") {
    const cap = MODEL_CAPABILITIES[m]
    return { model: m, thinking: cap.thinking, search: cap.search }
  }
  return { model: m, thinking, search }
}

export function startBridge(
  client: DeepSeekClient,
  models: ModelSpec[],
  opts: BridgeOptions & { log: (msg: string) => void },
): Promise<{ port: number; close: () => Promise<void> }> {
  const log = opts.log

  function sendSSE(res: http.ServerResponse, obj: unknown) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  function chunkOpts(id: string, created: number, model: string) {
    return { id, object: "chat.completion.chunk", created, model } as const
  }

  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: any
    let raw = ""
    for await (const piece of req) raw += piece
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }))
      return
    }
    const stream = body.stream !== false
    const tools: unknown[] | undefined = Array.isArray(body.tools) ? body.tools : undefined
    const toolNames: string[] = (tools ?? [])
      .map((t: any) => t?.function?.name ?? t?.name)
      .filter((n: unknown): n is string => typeof n === "string" && !!n)

    const messages: any[] = Array.isArray(body.messages) ? body.messages : []
    const { model, thinking, search } = normalizeModelID(body.model)
    const prompt = buildPrompt(messages, tools)

    const id = `chatcmpl-${Math.random().toString(16).slice(2, 14)}`
    const created = Math.floor(Date.now() / 1000)

    log(`[bridge] request model=${model} stream=${stream} msgs=${messages.length} tools=${toolNames.length}`)

    // Abort upstream work when the client (OpenCode) closes the connection.
    const ac = new AbortController()
    const onClientClose = () => ac.abort()
    req.on("close", onClientClose)

    // Track the requested model name so OpenAI status errors surface verbatim.
    try {
      const session = await client.createSession(ac.signal)
      const gen = client.completion(prompt, {
        chatSessionId: session,
        thinking,
        search,
        temperature: body.temperature,
        topP: body.top_p,
        maxTokens: body.max_tokens,
        signal: ac.signal,
      })

      const bufferContent = !!tools?.length // buffer when tool-calling
      let fullText = ""
      let fullReasoning = ""
      let wroteAny = false
      const writeHeadOnce = () => {
        if (stream && !wroteAny) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          })
          wroteAny = true
        }
      }

      const emitDelta = (delta: Record<string, unknown>) => {
        writeHeadOnce()
        const obj = {
          ...chunkOpts(id, created, body.model ?? model),
          choices: [
            { index: 0, delta, finish_reason: null as string | null },
          ],
        }
        sendSSE(res, obj)
      }

      for await (const chunk of gen) {
        const text = sanitizeLeakedOutput(chunk.text)
        if (!text) continue
        if (chunk.type === "thinking") {
          fullReasoning += text
          if (stream && !bufferContent) {
            // Emit both spellings so every runtime picks up reasoning deltas.
            emitDelta({ reasoning_content: text, reasoning: text })
          }
        } else {
          fullText += text
          if (stream && !bufferContent) emitDelta({ content: text })
        }
      }

      let finishReason = "stop"
      let toolCalls: ReturnType<typeof parseDsmlToolCalls>[0] = []
      let contentText = fullText

      if (!fullText.trim() && !fullReasoning.trim() && !(tools?.length)) {
        throw new DeepSeekError(502, "", "DeepSeek returned an empty stream (throttled / rate-limited / WAF soft-block). Try again in a moment.")
      }

      if (tools?.length) {
        const [parsed, cleaned] = parseDsmlToolCalls(fullText, toolNames)
        toolCalls = parsed
        contentText = sanitizeLeakedOutput(cleaned)
        if (toolCalls.length) finishReason = "tool_calls"
      }

      if (!stream) {
        const message: Record<string, unknown> = { role: "assistant", content: contentText }
        if (toolCalls.length) {
          message["content"] = contentText || null
          message["tool_calls"] = toolCalls
        }
        if (thinking || fullReasoning) message["reasoning_content"] = fullReasoning
        const usage = {
          prompt_tokens: Math.ceil(prompt.length / 2.5),
          completion_tokens: Math.ceil((contentText.length + fullReasoning.length) / 2.5),
          total_tokens: Math.ceil((prompt.length + contentText.length + fullReasoning.length) / 2.5),
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: body.model ?? model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          }),
        )
        return
      }

      // Streaming finish: buffered tool path flushes content now, others already streamed.
      if (tools?.length) {
        if (fullReasoning) {
          emitDelta({ reasoning_content: fullReasoning, reasoning: fullReasoning })
        }
        if (contentText) emitDelta({ content: contentText })
        toolCalls.forEach((tc, i) => {
          emitDelta({
            content: null,
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
              },
            ],
          })
        })
      }

      sendSSE(res, {
        ...chunkOpts(id, created, body.model ?? model),
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })
      sendSSE(res, {
        ...chunkOpts(id, created, body.model ?? model),
        choices: [],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 2.5),
          completion_tokens: Math.ceil((contentText.length + fullReasoning.length) / 2.5),
          total_tokens: Math.ceil((prompt.length + contentText.length + fullReasoning.length) / 2.5),
        },
      })
      res.write("data: [DONE]\n\n")
      res.end()
    } catch (e) {
      const status =
        ((e as { status?: number }).status as number | undefined) ??
        (e instanceof DeepSeekError ? e.status : 500)
      const isAuth = status === 401
      const message =
        e instanceof DeepSeekError
          ? e.message
          : `DeepSeek web bridge error: ${(e as Error)?.message ?? String(e)}`
      log(`[bridge] error: ${message.slice(0, 200)}`)
      const payload = {
        error: {
          message,
          type: isAuth ? "authentication_error" : "api_error",
          code: status,
        },
      }
      if (stream && res.headersSent) {
        sendSSE(res, payload)
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        res.writeHead(status === 401 ? 401 : 502, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (
      (req.method === "GET" && (path === "/v1/models" || path === "/models")) ||
      (req.method === "GET" && (path === "/" || path === "/health"))
    ) {
      res.writeHead(200, { "content-type": "application/json", ...cors })
      res.end(
        JSON.stringify({
          object: "list",
          data: models.map((m) => ({
            id: `deepseek-${m.id}`,
            object: "model",
            created: 1704067200,
            owned_by: "deepseek-web",
          })),
        }),
      )
      return
    }
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChat(req, res)
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `unknown path ${path}` } }))
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : opts.port
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
