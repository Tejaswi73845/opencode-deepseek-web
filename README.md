# opencode-deepseek-web

Use your **DeepSeek web-chat** session (the one from chat.deepseek.com in your browser) inside
[OpenCode](https://opencode.ai) — no API key, no platform top-up. Your browser session cookie is
all you need.

```
┌──────────┐  OpenAI-compatible   ┌───────────────────────────┐   DeepSeek web protocol    ┌─────────────────────┐
│ OpenCode │ ───────────────────▶ │ local bridge (127.0.0.1)  │ ─────────────────────────▶ │ chat.deepseek.com   │
│  /models │   provider plugin    │ PoW solver · SSE · DSML   │  Bearer <userToken>        │  (web chat backend) │
└──────────┘                      └───────────────────────────┘                            └─────────────────────┘
```

## Models

| OpenCode model             | DeepSeek web backend        |
| -------------------------- | --------------------------- |
| `deepseek-web/chat`        | DeepSeek V-series chat      |
| `deepseek-web/reasoner`    | Thinking (R) mode           |
| `deepseek-web/search`      | Chat with web search        |
| `deepseek-web/reasoner-search` | Thinking + web search  |

Tool calling works via DeepSeek's DSML tool protocol (bridged transparently). Costs show 0
because these run against the web chat, which is covered by your DeepSeek web usage.

## Install

Already installed for this user via `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/tejaswi/opencode-deepseek-web"]
}
```

To use it in other locations, put the same `plugins` entry (or a copy of this directory,
then reference its path) in that project's `opencode.json(c)`, or publish/distribute the
directory as an npm package.

## Get your session token

DeepSeek's web app keeps your session in the `userToken` cookie on `chat.deepseek.com`.
Any of these gets it to the plugin:

**A. Helper script (local browsers)**

```bash
python3 scripts/extract-deepseek-cookie.py --write
```

Searches Chrome/Chromium/Brave/Edge/Vivaldi and Firefox cookie stores (including WSL Windows
locations — Windows-bound encrypted cookies often cannot be decrypted, in which case use C).
`--write` stores the result in the token file for you.

**B. DevTools — copy the live cURL request (most reliable)**

```bash
# 1) Open https://chat.deepseek.com, send any chat message while logged in.
# 2) DevTools (F12) → Network → type "completion" in the filter → click the
#    POST /api/v0/chat/completion request → Copy → Copy as cURL (bash).
# 3) Save that text to a private file and run:
python3 scripts/import-curl-token.py /path/to/curl.txt --write
```

This imports the exact `authorization: Bearer` token your browser is actively using —
recommended over the cookie, since DeepSeek's token scheme has changed
(see `40003 INVALID_TOKEN` below in troubleshooting).

**C. DevTools cookie value (works when the cookie is still the live credential)**

1. Open https://chat.deepseek.com and make sure you are logged in.
2. DevTools (F12) → **Application** → **Cookies** → `https://chat.deepseek.com` → copy the value of **`userToken`**.
3. Save it:

```bash
mkdir -p ~/.config/opencode/deepseek-web
echo '{"token": "PASTE_USER_TOKEN_HERE"}' > ~/.config/opencode/deepseek-web/token.json
```

(You can paste a whole `userToken=...; other=...` cookie string, a `Bearer ...` header value,
or the bare token — all are accepted.)

**D. Environment variable**

```bash
export DEEPSEEK_WEB_TOKEN="PASTE_USER_TOKEN_HERE"
```

**E. Plugin options** (in the `plugins` entry):

```jsonc
{
  "package": "/home/tejaswi/opencode-deepseek-web",
  "options": { "token": "userToken=PASTE...", "userAgent": "<your Chrome user-agent>", "port": 8178 }
}
```

The token is re-read on every plugin setup. After (re)placing a token, touch your
`opencode.json` or run `opencode service restart` to make the running server reload it.

> The token is a full session credential. Keep it in your user config only, never commit it.

## Options

| option         | default          | meaning                                              |
| -------------- | ---------------- | ---------------------------------------------------- |
| `token`        | —                | token/cookie string or `path:/file`                  |
| `cookie`       | —                | cookie header string fallback                        |
| `tokenFile`    | see above        | file that contains the token                         |
| `port`         | `8178` (env `DEEPSEEK_WEB_PORT`) | local bridge port; falls back to a random free port |
| `userAgent`    | Chrome 134 UA    | sent to DeepSeek; set it to your real browser UA if you hit WAF blocks |
| `contextLimit` | `262144`         | advertised context window                            |
| `outputLimit`  | `65536`          | advertised max output tokens                         |

## How it works / protocol notes

Each request the bridge:

1. `POST /api/v0/chat_session/create` — opens a fresh web-chat session,
2. `POST /api/v0/chat/create_pow_challenge` — fetches a **DeepSeekHashV1** proof-of-work
   challenge and solves it (`sha3_256(challenge + salt_expireAt_nonce)` little-endian
   `< 2^32/difficulty`, ~30k iterations), sending the result as `x-ds-pow-response`,
3. `POST /api/v0/chat/completion` — streams the answer and translates DeepSeek's internal
   SSE (`response/fragments`, `p: response/content`, pathless continuation lines) into
   OpenAI-style deltas, mapping `THINK` fragments to `reasoning_content` for the reasoner,
4. translates the multi-turn OpenAI message array into a DeepSeek-native prompt
   (`<｜begin▁of▁sentence｜>…` markers) since the web endpoint takes one flat prompt.

Protocol reverse-engineering is based on the deepseek-free-api family of projects
(LLM-Red-Team and maintained forks, e.g. Fly143/deepseek-free-api, Nov 2026).

### Known limitations

- **Text only** — no image/file uploads (the web API needs a separate upload+fork flow).
- Token expiry (session invalidation / logout elsewhere) surfaces as an auth error — grab a
  fresh `userToken` and re-run. Sessions in the web chat have their own usage quotas.
- DeepSeek's cloud WAF may occasionally block non-browser TLS fingerprints; if you see
  HTTP 403/202 WAF responses, retry later and set `userAgent` to your real browser UA.
- Under the hood this is an unofficial API — DeepSeek can change or restrict it at any time,
  and your regular browser usage shares the same rate limits as OpenCode requests.

### `40003 INVALID_TOKEN` — the token scheme changed

DeepSeek has rotated its web token scheme: the `userToken` **cookie** value may no longer be
the live credential DeepSeek expects in `Authorization: Bearer`. If you get
`{"code":40003,"msg":"INVALID_TOKEN"}`, import the live request instead:

```bash
# 1) DevTools (F12) → Network → filter "completion" → click the
#    /api/v0/chat/completion request → Copy → Copy as cURL (bash)
# 2) save it somewhere private and run:
python3 scripts/import-curl-token.py /path/to/curl.txt --write
# 3) touch ~/.config/opencode/opencode.json   (or: opencode service restart)
```

This captures the exact `authorization` header your browser is actively using (plus your
real user-agent), which has proven far more reliable than copying cookies.

## Development

```bash
/mnt/c/Program\ Files/nodejs/node.exe test/selftest.ts   # WSL: offline unit tests
opencode service restart && opencode models | grep deepseek-web
curl http://127.0.0.1:8178/v1/models                      # bridge is live
```

Source layout: `src/index.ts` (plugin + token resolution) · `src/bridge.ts` (OpenAI compat)
· `src/deepseek.ts` (web client + SSE parser) · `src/pow.ts` (PoW solver) ·
`src/prompt.ts` (message→prompt) · `src/dsml.ts` (DSML tool calls) ·
`scripts/extract-deepseek-cookie.py` (token extraction) · `test/selftest.ts` (unit tests).
