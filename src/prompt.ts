/**
 * Build a DeepSeek-native multi-turn prompt from OpenAI-style chat messages.
 *
 * Port of deepseek-free-api's convert_messages_for_deepseek: multi-turn
 * conversations are flattened into a single prompt with DeepSeek's native
 * in-context markers, because the web /chat/completion endpoint accepts a
 * single "prompt" string per message.
 */
import { buildDsmlToolPrompt, formatToolCallsForPrompt } from "./dsml.ts"

const BOS = "<｜begin▁of▁sentence｜>"
const SYS = "<｜System｜>"
const USER = "<｜User｜>"
const ASST = "<｜Assistant｜>"
const TOOL = "<｜Tool｜>"
const EOS = "<｜end▁of▁sentence｜>"
const TOOL_END = "<｜end▁of▁toolresults｜>"
const SYS_END = "<｜end▁of▁instructions｜>"

interface OAIChatMessage {
  role?: string
  content?: unknown
  tool_calls?: unknown
  reasoning_content?: unknown
  [k: string]: unknown
}

function contentToText(content: unknown, opts: { dropImages?: boolean } = {}): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    let dropped = false
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as any
        if (p.type === "text" && typeof p.text === "string") {
          parts.push(p.text)
        } else if (typeof p.text === "string") {
          parts.push(p.text)
        } else {
          dropped = true
        }
      } else if (typeof part === "string") {
        parts.push(part)
      }
    }
    let joined = parts.join(" ")
    if (dropped && opts.dropImages !== false) {
      joined += "\n\n[Non-text attachments (images etc.) are not supported by the DeepSeek web chat bridge and were dropped.]"
    }
    return joined
  }
  return JSON.stringify(content)
}

export function buildPrompt(messages: OAIChatMessage[], tools?: unknown[]): string {
  const parts: string[] = [BOS]
  let hasSystem = false

  for (const msg of messages) {
    const role = String(msg?.role ?? "")
    const content = msg?.content

    if (role === "system" || role === "developer") {
      hasSystem = true
      let text = contentToText(content)
      if (Array.isArray(tools) && tools.length) {
        const toolText = buildDsmlToolPrompt(tools)
        if (toolText) text = text ? text + "\n\n" + toolText : toolText
      }
      if (text.trim()) parts.push(SYS + text + SYS_END)
    } else if (role === "user") {
      parts.push(USER + contentToText(content))
    } else if (role === "assistant") {
      const segs: string[] = []
      const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : ""
      if (reasoning) segs.push(reasoning)
      const asstText = contentToText(content)
      if (asstText.trim()) segs.push(asstText.trim())
      if (msg.tool_calls) {
        const dsml = formatToolCallsForPrompt(msg.tool_calls)
        if (dsml) segs.push(dsml)
      }
      if (segs.length) parts.push(ASST + "\n\n" + segs.join("\n\n") + EOS)
    } else if (role === "tool") {
      let result = typeof content === "string" ? content : contentToText(content)
      // Tool results can be big JSON envelopes; strip obvious wrappers.
      if (result) {
        try {
          const parsed = JSON.parse(result)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const extracted: string[] = []
            for (const key of ["output", "error", "result", "content", "text"]) {
              const v = (parsed as any)[key]
              if (v != null && String(v).trim()) extracted.push(String(v).trim())
            }
            if (extracted.length) result = extracted.join("\n")
          }
        } catch {
          /* not JSON — keep as-is */
        }
      }
      if (result) parts.push(TOOL + result.slice(0, 500) + TOOL_END)
    } else {
      // unknown roles land as user-ish content so nothing is silently lost
      const text = contentToText(content)
      if (text.trim()) parts.push(USER + `[${role}] ` + text)
    }
  }

  if (Array.isArray(tools) && tools.length && !hasSystem) {
    const toolText = buildDsmlToolPrompt(tools)
    if (toolText) parts.splice(1, 0, SYS + toolText + SYS_END)
  }

  // The prompt must end with the Assistant turn opener so DeepSeek completes it.
  // NOTE: do not run sanitizeLeakedOutput here — the DsML/sentinel markers are
  // intentional for the upstream model, only model OUTPUT gets sanitized.
  parts.push(ASST)
  return parts.join("")
}
