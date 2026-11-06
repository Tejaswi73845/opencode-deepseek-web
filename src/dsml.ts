/**
 * DSML tool-call bridging for DeepSeek web chat.
 *
 * DeepSeek's web backend is not exposed with a function-calling API, so tool
 * calling is driven via DeepSeek's DSML markup in plain text:
 * the available tools are described in the system prompt and the model answers
 * with a `<|DSML|tool_calls>` block which we parse back into OpenAI-style
 * tool_calls. Simplified TS port of deepseek-free-api's tool_dsml.py.
 */

const CDATA_OPEN = "<![CDATA["
const CDATA_CLOSE = "]]>"

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
}

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

function newId(): string {
  let s = ""
  while (s.length < 24) s += Math.floor(Math.random() * 16).toString(16)
  return `call_${s.slice(0, 24)}`
}

function htmlUnescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#x27|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
}

function autoType(val: string): unknown {
  const low = val.toLowerCase()
  if (low === "true") return true
  if (low === "false") return false
  if (low === "null" || low === "none") return null
  if (/^-?\d+$/.test(val)) {
    const n = parseInt(val, 10)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?\d+\.\d+$/.test(val)) {
    const f = parseFloat(val)
    if (Number.isFinite(f)) return f
  }
  return val
}

/** Repair missing quotes around JSON object keys. */
function repairLooseJSON(text: string): string {
  return text
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/:\s*'((?:[^'\\]|\\.)*)'/g, ': "$1"')
}

function parseJSONLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const repaired = repairLooseJSON(text)
    if (repaired !== text) {
      try {
        return JSON.parse(repaired)
      } catch {
        /* fall through */
      }
    }
    return autoType(text)
  }
}

/** Extract CDATA or raw content, matching deepseek-free-api's CDATA handling. */
function extractParameterText(raw: string, key: string, wasWrapped: boolean): string {
  let val = raw
  if (wasWrapped) {
    val = val.slice(CDATA_OPEN.length, -CDATA_CLOSE.length).replace("]]]]><![CDATA[>", "]]>")
  }
  if (wasWrapped && preservesCDATA(key)) {
    return val // keep CDATA exactly as written (content, code, file_content, ...)
  }
  val = val.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(?:p|div|li)>/gi, "\n")
  return htmlUnescape(val) as never as string
}

const CDATA_PRESERVED = new Set([
  "content", "file_content", "text", "prompt", "query", "command", "cmd", "script", "code",
  "old_string", "new_string", "pattern", "path", "file_path", "result", "input",
])

function preservesCDATA(key: string): boolean {
  return CDATA_PRESERVED.has(key)
}

/** Normalize DSML markup variants (<|DSML|x>, <｜DSML｜x>, <dsml-x>) to plain <x> */
export function stripDsmlMarkup(text: string): string {
  let out = text.replace(/\uFF5C/g, "|")
  // open tags: <|DSML|invoke ... > / <|DSML|parameter ...
  out = out.replace(/<\s*\|?\s*DSML\s*\|?\s*(?=[a-zA-Z_])/gi, "<")
  // close tags: </|DSML|parameter> / </｜DSML｜tool_calls>
  out = out.replace(/<\/\s*\|?\s*DSML\s*\|?\s*(?=[a-zA-Z_])/gi, "</")
  // <dsml-tool_calls> / <dsml_tool_calls>
  out = out.replace(/<(\/?)dsml[-_]?/gi, "<$1")
  return out
}

/** Fix unclosed CDATA segments before parsing. */
function sanitizeLooseCdata(text: string): string {
  if (!text.includes(CDATA_OPEN)) return text
  let result = ""
  let start = 0
  for (;;) {
    const pos = text.indexOf(CDATA_OPEN, start)
    if (pos === -1) {
      result += text.slice(start)
      break
    }
    result += text.slice(start, pos)
    const close = text.indexOf(CDATA_CLOSE, pos + CDATA_OPEN.length)
    if (close === -1) {
      result += text.slice(pos) + CDATA_CLOSE
      break
    }
    result += text.slice(pos, close + CDATA_CLOSE.length)
    start = close + CDATA_CLOSE.length
  }
  return result
}

function resolveToolName(name: string, toolNames: string[]): string {
  if (toolNames.includes(name)) return name
  const lower = name.toLowerCase()
  const exact = toolNames.find((t) => t.toLowerCase() === lower)
  if (exact) return exact
  const fuzzy = toolNames.find((t) => lower.includes(t.toLowerCase()) || t.toLowerCase().includes(lower))
  return fuzzy ?? name
}

function parseParameters(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const paramPattern = /<param(?:eter)?\s+name=["']([^"']+)["']>([\s\S]*?)<\/param(?:eter)?>/gi
  let m: RegExpExecArray | null
  while ((m = paramPattern.exec(inner)) !== null) {
    const key = m[1].trim()
    let val = m[2].trim()
    const wrapped = val.startsWith(CDATA_OPEN) && val.endsWith(CDATA_CLOSE)
    val = extractParameterText(val, key, wrapped)
    let typed: unknown = parseJSONLoose(val)
    if (typeof typed === "string" && !preservesCDATA(key)) typed = htmlUnescape(typed)
    if (key in args) {
      const prev = args[key]
      if (Array.isArray(prev)) (prev as unknown[]).push(typed)
      else args[key] = [prev, typed]
    } else {
      args[key] = typed
    }
  }
  return args
}

function formatToolCall(name: string, args: Record<string, unknown>): ToolCall | null {
  if (!name) return null
  return {
    id: newId(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** Remove tool markup leftovers so clean content can be shown to the user. */
function cleanMarkup(text: string): string {
  let out = text
  out = out.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, "")
  out = out.replace(/<tool_calls?\b[^>]*>/gi, "")
  out = out.replace(/<\/?tool_calls?>/gi, "")
  out = out.replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
  out = out.replace(/<invoke\b[^>]*\/?>/gi, "")
  out = out.replace(/<parameter\b[\s\S]*?<\/parameter>/gi, "")
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
  out = out.replace(/\[citation:\d+\]/g, "")
  return out
}

/**
 * Parse tool calls out of assistant text.
 * Returns [toolCalls, cleanedText].
 */
export function parseDsmlToolCalls(
  rawText: string,
  toolNames: string[] = [],
): [ToolCall[], string] {
  if (!rawText) return [[], rawText]
  let text = rawText
  if (text.includes(CDATA_OPEN)) text = sanitizeLooseCdata(text)

  const hasClose = /<\/\s*(?:dsml[-_]?|)?tool_calls\s*>/i.test(text) || /<\/tool_calls>/i.test(text)
  const normalizedProbe = text.replace(/[\s\uFF5C|]/g, "")
  const hasOpen = /<tool_calls/i.test(normalizedProbe) || /<invoke\s+name=/i.test(text)
  if (hasClose && !hasOpen) text = "<tool_calls>\n" + text

  // Normalize DSML markup first, THEN unwrap markdown fences around tool blocks.
  const preNormalized = stripDsmlMarkup(text)
  const normalized = preNormalized.replace(
    /```(?:xml)?\s*\n?([\s\S]*?```)/g,
    (whole: string, inner: string) => {
      return inner.includes("<tool_calls") || inner.includes("<invoke")
        ? inner.replace(/```\s*$/, "")
        : whole
    },
  )
  const toolCalls: ToolCall[] = []

  const invokePattern = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi
  const blocks: string[] = []
  const blockPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockPattern.exec(normalized)) !== null) blocks.push(blockMatch[1])

  const scan = (block: string) => {
    let m: RegExpExecArray | null
    invokePattern.lastIndex = 0
    while ((m = invokePattern.exec(block)) !== null) {
      const name = m[1].trim()
      const args = parseParameters(m[2])
      const tc = formatToolCall(resolveToolName(name, toolNames), args)
      if (tc) toolCalls.push(tc)
    }
  }

  if (blocks.length) {
    blocks.forEach(scan)
  } else {
    // Bare <invoke> blocks without a wrapper
    scan(normalized)
  }

  const cleaned = cleanMarkup(normalized).trim()
  return [toolCalls, cleaned]
}

/* ─── Formatting: tool definitions → prompt, prior calls → transcript ─── */

function cdata(text: string): string {
  const safe = text.replace(/]]>/g, "]]]]><![CDATA[>")
  return `${CDATA_OPEN}${safe}${CDATA_CLOSE}`
}

function escapeXmlAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TOOLS_PROMPT_HEADER = `TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
4) All string values must use <![CDATA[...]]>, even short ones.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Objects use nested XML elements. Arrays may repeat <item> children.
7) Numbers, booleans, and null stay plain text.
8) Use only the parameter names in the tool schema. Do not invent fields.
9) Do NOT wrap XML in markdown fences. Do NOT output explanations or role markers.
10) If you call a tool, the first non-whitespace characters must be exactly <|DSML|tool_calls>.
11) Never omit the opening <|DSML|tool_calls> tag.
12) When you do not need a tool, answer normally without any DSML block.

Remember: The ONLY valid way to use tools is the <|DSML|tool_calls>...</|DSML|tool_calls> block.
`

/** Build the system-prompt section describing available tools (DSML protocol). */
export function buildDsmlToolPrompt(tools: unknown[]): string {
  if (!Array.isArray(tools) || tools.length === 0) return ""
  let prompt = TOOLS_PROMPT_HEADER + "\nAvailable tools:\n"
  for (const tool of tools) {
    const t = (tool ?? {}) as any
    const fn = (t.function ?? t) as any
    const name = String(fn.name ?? "")
    if (!name) continue
    const desc = String(fn.description ?? t.description ?? "").split("\n")[0].trim()
    prompt += desc ? `  - ${name}: ${desc}\n` : `  - ${name}\n`
  }
  return prompt
}

function formatXmlNode(name: string, value: unknown, indent: string): string {
  if (value == null) return `${indent}<${name}></${name}>`
  if (typeof value === "object" && !Array.isArray(value)) {
    const inner = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => formatXmlNode(k, v, indent + "  "))
      .join("\n")
    return inner.trim() ? `${indent}<${name}>\n${inner}\n${indent}</${name}>` : `${indent}<${name}></${name}>`
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatXmlNode(name, item, indent)).join("\n")
  }
  if (typeof value === "boolean" || typeof value === "number") return `${indent}<${name}>${String(value)}</${name}>`
  return `${indent}<${name}>${cdata(String(value))}</${name}>`
}

function formatParamNode(name: string, value: unknown, indent: string): string {
  const open = `<|DSML|parameter name="${escapeXmlAttr(name)}">`
  const close = "</|DSML|parameter>"
  if (value == null) return `${indent}${open}${close}`
  if (typeof value === "object" && !Array.isArray(value)) {
    const inner = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => formatXmlNode(k, v, indent + "  "))
      .join("\n")
    return inner.trim() ? `${indent}${open}\n${inner}\n${indent}${close}` : `${indent}${open}${close}`
  }
  if (Array.isArray(value)) {
    const inner = value.map((item) => formatXmlNode("item", item, indent + "  ")).join("\n")
    return `${indent}${open}\n${inner}\n${indent}${close}`
  }
  if (typeof value === "boolean" || typeof value === "number") return `${indent}${open}${String(value)}${close}`
  return `${indent}${open}${cdata(String(value))}${close}`
}

function formatParamsDsml(args: unknown, indent = "    "): string {
  if (args != null && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return entries.map(([k, v]) => formatParamNode(k, v, indent)).join("\n")
  }
  if (Array.isArray(args)) return args.map((item) => formatParamNode("item", item, indent)).join("\n")
  if (typeof args === "string") return `${indent}<|DSML|parameter name="content">${cdata(args)}</|DSML|parameter>`
  return `${indent}<|DSML|parameter name="value">${String(args)}</|DSML|parameter>`
}

/** Render prior assistant tool_calls back into the DSML transcript format. */
export function formatToolCallsForPrompt(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return ""
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return ""

  const blocks: string[] = []
  for (const tc of raw as any[]) {
    if (!tc || typeof tc !== "object") continue
    const fn = (tc.function ?? {}) as any
    const name = tc.name || fn.name
    if (!name) continue
    let args: unknown = tc.arguments ?? fn.arguments ?? "{}"
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        /* keep as string */
      }
    }
    const params = formatParamsDsml(args)
    let block = `  <|DSML|invoke name="${escapeXmlAttr(String(name))}">`
    if (params.trim()) block += "\n" + params + "\n  </|DSML|invoke>"
    else block += "</|DSML|invoke>"
    blocks.push(block)
  }
  if (!blocks.length) return ""
  return "<|DSML|tool_calls>\n" + blocks.join("\n") + "\n</|DSML|tool_calls>"
}

/** Remove leaked DeepSeek sentinel markers from model output. */
export function sanitizeLeakedOutput(text: string): string {
  if (!text) return text
  return text
    .replace(/<[｜|]\s*begin[_▁]of[_▁]sentence\s*[｜|]>/gi, "")
    .replace(
      /<[｜|]\s*(?:assistant|tool|user|end[_▁]of[_▁]sentence|end[_▁]of[_▁]thinking|end[_▁]of[_▁]toolresults|end[_▁]of[_▁]instructions)\s*[｜|]>/gi,
      "",
    )
    .replace(/\[citation:\d+\]/g, "")
}
