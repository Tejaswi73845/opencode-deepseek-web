/**
 * Offline tests for the pure logic in opencode-deepseek-web.
 * Run with a modern Node (>= 22.6): node --experimental-strip-types test/selftest.ts
 * (Node 26 runs .ts with type stripping by default.)
 */
import { solvePoW } from "../src/pow.ts"
import { buildPrompt } from "../src/prompt.ts"
import { parseDsmlToolCalls, buildDsmlToolPrompt, formatToolCallsForPrompt, stripDsmlMarkup } from "../src/dsml.ts"
import { normalizeModelID, DEFAULT_MODEL_SPECS } from "../src/bridge.ts"

let failures = 0
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

/* ── PoW solver ── */
console.log("pow.ts")
{
  // Low difficulty so the loop finishes fast.
  const { answer, response } = await solvePoW({
    algorithm: "DeepSeekHashV1",
    challenge: "b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1",
    salt: "dde3ed472be5a2494ee0",
    difficulty: 144000,
    expire_at: 1777057596443,
    signature: "test",
    target_path: "/api/v0/chat/completion",
  })
  check("solvePoW returns a nonce", answer >= 0, `answer=${answer}`)
  const decoded = JSON.parse(Buffer.from(response, "base64").toString())
  check("PoW response payload round-trips", decoded.answer === answer && decoded.challenge === "b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1" && decoded.signature === "test")
}

/* ── DSML parsing ── */
console.log("dsml.ts")
{
  const dsml = [
    "<|DSML|tool_calls>",
    '  <|DSML|invoke name="read_file">',
    '    <|DSML|parameter name="path"><![CDATA[/tmp/x.txt]]></|DSML|parameter>',
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
  ].join("\n")
  const [calls, cleaned] = parseDsmlToolCalls(dsml, ["read_file"])
  check("DSML block parsed", calls.length === 1)
  check("tool name", calls[0]?.function.name === "read_file")
  check("CDATA string arg", JSON.parse(calls[0]?.function.arguments ?? "{}").path === "/tmp/x.txt")
  check("text cleaned", cleaned === "", JSON.stringify(cleaned))
}

{
  // numeric + boolean + nested object
  const dsml = [
    "<|DSML|tool_calls>",
    '  <|DSML|invoke name="grep">',
    '    <|DSML|parameter name="limit">20</|DSML|parameter>',
    '    <|DSML|parameter name="regex">deep.*web</|DSML|parameter>',
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
  ].join("\n")
  const [calls] = parseDsmlToolCalls(dsml, ["grep"])
  const args = JSON.parse(calls[0]?.function.arguments ?? "{}")
  check("numeric arg typed", args.limit === 20, JSON.stringify(args))
  check("string arg", args.regex === "deep.*web")
}

{
  // model wraps in xml code fence
  const dsml = "let me check.\n```xml\n<|DSML|tool_calls>\n<|DSML|invoke name=\"a\">\n</|DSML|invoke>\n</|DSML|tool_calls>\n```\n"
  const [calls, cleaned] = parseDsmlToolCalls(dsml, ["a"])
  check("fenced block parsed", calls.length === 1)
  check("fence+prose cleaned", cleaned === "let me check.", JSON.stringify(cleaned))
}

{
  // missing wrapper open tag
  const dsml = '  <|DSML|invoke name="missing_wrap"><|DSML|parameter name="x">1</|DSML|parameter></|DSML|invoke>\n</|DSML|tool_calls>'
  const [calls] = parseDsmlToolCalls(dsml, ["missing_wrap"])
  check("missing wrapper recovered", calls.length === 1 && calls[0].function.name === "missing_wrap")
}

{
  // fullwidth pipe variants
  const dsml = "<｜DSML｜tool_calls>​<｜DSML｜invoke name=\"a\">​</｜DSML｜invoke>​</｜DSML｜tool_calls>"
  const [calls] = parseDsmlToolCalls(dsml, ["a"])
  check("fullwidth pipes", calls.length === 1)
}

{
  // U+FF5C direct in stripDsmlMarkup
  check("stripDsmlMarkup normalizes", stripDsmlMarkup("<｜DSML｜tool_calls>") === "<tool_calls>", stripDsmlMarkup("<｜DSML｜tool_calls>"))
}

{
  // prose before tool calls gets cleaned
  const dsml = "I'll read the file.\n<tool_calls><invoke name=\"a\"><parameter name=\"p\">x</parameter></invoke></tool_calls>"
  const [calls, cleaned] = parseDsmlToolCalls(dsml, ["a"])
  check("prose + call parsed", calls.length === 1)
  check("prose preserved in cleaned text", cleaned === "I'll read the file.", cleaned)
}

{
  const prompt = buildDsmlToolPrompt([{ function: { name: "read", description: "Read a file\nmore" } }])
  check("tool prompt lists names", prompt.includes("- read: Read a file"))
}

{
  const transcript = formatToolCallsForPrompt([
    { function: { name: "read", arguments: '{"path":"/a"}' } },
  ])
  check("prior tool transcript", transcript.includes('<|DSML|invoke name="read">') && transcript.includes("<![CDATA[/a]]>"))
}

/* ── prompt builder ── */
console.log("prompt.ts")
{
  const p = buildPrompt(
    [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "What's up?" },
    ],
    [{ function: { name: "read", description: "Read a file" } }],
  )
  check("BOS first", p.startsWith("<｜begin▁of▁sentence｜>"))
  check("system segment", p.includes("<｜System｜>You are helpful.") && p.includes("<｜end▁of▁instructions｜>"))
  check("tool prompt injected into system", p.includes("Available tools:"))
  check("user turns marked", p.includes("<｜User｜>Hi") && p.includes("<｜User｜>What's up?"))
  check("assistant EOS", p.includes("<｜Assistant｜>\n\nHello!<｜end▁of▁sentence｜>"))
  check("ends with assistant opener", p.endsWith("<｜Assistant｜>"))
}

{
  const p = buildPrompt([
    { role: "tool", content: '{"output":"result text\\nline 2","error":null}' },
  ])
  check("tool envelope stripped", p.includes("<｜Tool｜>result text\nline 2<｜end▁of▁toolresults｜>"), JSON.stringify(p.slice(0, 120)))
}

{
  const p = buildPrompt([
    { role: "assistant", tool_calls: [{ function: { name: "read", arguments: '{"path":"/a"}' } }] },
  ])
  check("assistant tool_calls replayed as DSML", p.includes('<｜Assistant｜>\n\n<|DSML|tool_calls>'))
}

/* ── model id normalization ── */
console.log("bridge.ts")
{
  check("chat", normalizeModelID("deepseek-web/chat").thinking === false && normalizeModelID("deepseek-web/chat").search === false)
  check("reasoner", normalizeModelID("reasoner").thinking === true && !normalizeModelID("reasoner").search)
  check("full id with provider prefix", normalizeModelID("deepseek-web/reasoner-search").thinking && normalizeModelID("deepseek-web/reasoner-search").search)
  check("unknown falls back to chat", normalizeModelID("deepseek-chat").model === "chat")
  check("4 models", DEFAULT_MODEL_SPECS.length === 4)
}

/* ── SSE stream parsing ── */
console.log("deepseek.ts: SSE parsing")
{
  const { parseCompletionResponse } = await import("../src/deepseek.ts")
  const events = [
    'data: {"v":{"response":{"fragments":[{"id":1,"type":"THINK","content":""}]}}}',
    'data: {"p":"response/fragments/-1/content","v":"思考步"}',
    'data: {"v":"继续"}',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"你好"}]}',
    'data: {"v":"，世界"}',
    'data: {"p":"response/status","v":"FINISHED"}',
    "event: title",
    'data: {"p":"response/title","v":"新标题"}',
  ]
  const body = events.join("\n\n") + "\n\n"
  const out: Array<{ type: string; text: string }> = []
  for await (const chunk of parseCompletionResponse(body, true, () => {})) out.push(chunk)
  const seq = out.map((c) => `${c.type}:${c.text}`).join(" | ")
  check(
    "old + fragment formats parsed in order",
    seq === "thinking:思考步 | thinking:继续 | content:你好 | content:，世界",
    seq,
  )
}

{
  const { parseCompletionResponse } = await import("../src/deepseek.ts")
  const body = 'data: {"v":{"type":"error","content":"当前版本过低","finish_reason":"OTHER"}}\n\n'
  let errored = ""
  try {
    for await (const _chunk of parseCompletionResponse(body, false, () => {})) { /* drain */ }
  } catch (e) {
    errored = (e as Error).message
  }
  check("toast error throws", errored.includes("当前版本过低"), errored)
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
