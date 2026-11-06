#!/usr/bin/env python3
"""
Import a DeepSeek web-chat session into the opencode-deepseek-web plugin from a
cURL request copied out of your browser DevTools.

Why: DeepSeek rotates/derives the web session token, and the *safest* way to
capture the exact credential your browser is currently using is to copy the
network request itself, headers included.

Usage:
  1. Log in at https://chat.deepseek.com and send any chat message.
  2. DevTools (F12) -> Network -> find the request to `/api/v0/chat/completion`
     (filter: "completion"), right-click it -> Copy -> **Copy as cURL (bash)**.
  3. Paste the cURL into a file, then run:

       python3 import-curl-token.py  < curl.txt
       #    or:   python3 import-curl-token.py curl.txt
       #    add  --write   to also save it for the plugin

     or paste the cURL directly:

       python3 import-curl-token.py --write   # then paste cURL, end with Ctrl+D

Never commit the captured cURL: it contains your full session credentials.
"""
import json
import os
import re
import sys

TOKEN_FILE = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "opencode", "deepseek-web", "token.json",
)


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


def parse_curl_sh(text: str):
    """Extract (-method, headers, body, url) from a `curl ...` shell snippet."""
    headers = {}
    data = None
    urls = []
    method = "POST"

    # Join continuation backslashes robustly by simply tokenizing on $'...' aware
    # single quotes: iterate raw lines, join with \ continuations first.
    cmd = text.replace("\\\n", " ")
    # Remove leading $ if present
    cmd = cmd.strip()
    if cmd.startswith("$ "):
        cmd = cmd[2:]
    # Bash ANSI-C quoting from Chrome's "Copy as cURL (bash)": $'...' -> '...'
    cmd = cmd.replace("$'", "'").replace('$"', '"')

    # -H "header" / --header 'header'
    for m in re.finditer(r"""(?:^|\s)-{1,2}H\s*("([^"]*)"|'([^']*)'|(\S+))""", cmd, re.I):
        raw = next(g for g in m.groups() if g is not None)
        value = unquote(raw)
        if ":" in value:
            k, _, v = value.partition(":")
            headers[k.strip().lower()] = v.strip()

    # --data / -d
    m = re.search(r"""--data(?:-raw)?\s*("([^"]*)"|'([^']*)')""", cmd, re.I)
    if m:
        data = unquote(next(g for g in m.groups() if g is not None))
    else:
        m = re.search(r"""(?:^|\s)-{1,2}d\s*("([^"]*)"|'([^']*)')""", cmd)
        if m:
            data = unquote(next(g for g in m.groups() if g is not None))
    if data:
        for flag in ("--data-raw", "--data", "--form-string"):
            data = data.replace(flag, "").strip()
    headers.pop("content-length", None)
    headers.pop("host", None)
    headers.pop("accept-encoding", None)

    return headers, data


def extract_url(cmd: str):
    m = re.search(r"https?://[^\s\"']+", cmd)
    return m.group(0) if m else None


def main():
    raw_source = sys.argv[1] if (len(sys.argv) > 1 and not sys.argv[1].startswith("-")) else None
    write = "--write" in sys.argv
    if raw_source:
        text = open(raw_source).read()
    elif sys.stdin.isatty():
        print("Paste the copied cURL, end with Ctrl+D:", file=sys.stderr)
        text = sys.stdin.read()
    else:
        text = sys.stdin.read()

    headers, data = parse_curl_sh(text)
    cmd = text.replace("\\\n", " ")

    token = ""
    ah = headers.get("authorization", "")
    if ah.lower().startswith("bearer "):
        token = ah[7:]
    if not token:
        print("No `Authorization: Bearer ...` header found in the cURL.", file=sys.stderr)
        print("Make sure you copied a request to /api/v0/chat/completion while logged in.", file=sys.stderr)
        return 1

    session_id = ""
    for src in [extract_url(cmd) or "", data or ""]:
        m = re.search(r"[sS]ession[_-]?[iI]d[=:\"]+([0-9a-fA-F-]{36})", src)
        if m:
            session_id = m.group(1)
            break
    if not session_id:
        m = re.search(r"/a/chat/s/([0-9a-fA-F-]{36})", headers.get("referer", ""))
        if m:
            session_id = m.group(1)

    result = {"token": token}
    if session_id:
        result["session_id"] = session_id

    print(f"token: {token[:16]}...{token[-8:]}", file=sys.stderr)
    if session_id:
        print(f"session_id: {session_id}", file=sys.stderr)
    else:
        print("note: no session id found (fine — the plugin creates fresh sessions)", file=sys.stderr)

    if write:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, "w") as fh:
            json.dump(result, fh)
        os.chmod(TOKEN_FILE, 0o600)
        print(f"Wrote {TOKEN_FILE}", file=sys.stderr)
        print("Now touch your opencode.json or run: opencode service restart", file=sys.stderr)
    else:
        print(token)

    return 0


if __name__ == "__main__":
    sys.exit(main())
