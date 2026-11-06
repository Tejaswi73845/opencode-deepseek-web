#!/usr/bin/env python3
"""
Extract the DeepSeek web-chat session token (`userToken` cookie) from a
locally installed browser, so you can use your real browser session in
OpenCode with the opencode-deepseek-web plugin.

Best effort, focused on Linux:
  * Chrome / Chromium / Edge / Brave / Vivaldi (Secret Service keyring
    via ctypes, or the well-known "peanuts" fallback)
  * Firefox (plain SQLite, flatpak locations included)

Usage:
    python3 extract-deepseek-cookie.py                  # search all browsers
    python3 extract-deepseek-cookie.py chrome           # only Chrome-family
    python3 extract-deepseek-cookie.py firefox          # only Firefox
    python3 extract-deepseek-cookie.py --write          # also write ~/$XDG_CONFIG_HOME/opencode/deepseek-web/token.json

Never share this token: it grants access to your DeepSeek account.
"""
import ctypes
import ctypes.util
import glob
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile

COOKIE_NAME = "userToken"

CHROME_CANDIDATES = {
    "chrome": "~/.config/google-chrome/*/Cookies",
    "chromium": "~/.config/chromium/*/Cookies",
    "brave": "~/.config/BraveSoftware/Brave-Browser/*/Cookies",
    "edge": "~/.config/microsoft-edge/*/Cookies",
    "vivaldi": "~/.config/vivaldi/*/Cookies",
    "chrome flatpak": "~/.var/app/com.google.Chrome/config/google-chrome/*/Cookies",
    # WSL: Windows-side browser profiles. Note: Windows加密 cookie 需要 DPAPI/App-Bound
    # 解密，通常无法直接解出；若失败请用 DevTools 手动复制。
    "chrome (WSL)": "/mnt/c/Users/*/AppData/Local/Google/Chrome/User Data/*/Cookies",
    "edge (WSL)": "/mnt/c/Users/*/AppData/Local/Microsoft/Edge/User Data/*/Cookies",
    "brave (WSL)": "/mnt/c/Users/*/AppData/Local/BraveSoftware/Brave-Browser/User Data/*/Cookies",
}
FIREFOX_GLOBS = [
    "~/.mozilla/firefox/*/cookies.sqlite",
    "~/.var/app/org.mozilla.firefox/.mozilla/firefox/*/cookies.sqlite",
]


class Keyring:
    """Minimal ctypes bindings to libsecret + libcrypto for Chrome cookie keys."""

    def __init__(self):
        libcrypto = ctypes.util.find_library("crypto") or ctypes.util.find_library("libcrypto.so.3")
        libsecret = ctypes.util.find_library("secret-1")
        self.crypto = ctypes.CDLL(libcrypto) if libcrypto else None
        self.secret = ctypes.CDLL(libsecret) if libsecret else None
        if self.crypto:
            self.crypto.EVP_sha1.restype = ctypes.c_void_p

    def password(self, schema_id, value="chrome"):
        """Look up a password in the Secret Service (we only need its value)."""
        if not self.secret:
            return None
        try:
            from ctypes import byref, c_char_p, c_void_p

           #a schema with name + string attributes, "application" attribute
            schema = self.secret.secret_schema_new(
                c_char_p(schema_id.encode()),
                ctypes.c_int(0),
                c_char_p(b"application"),
                ctypes.c_int(0),
                c_char_p(value.encode()),
                ctypes.c_void_p(),
            )
            error = c_void_p()
            pw = self.secret.secret_password_lookup_sync(
                schema,
                None,
                byref(error),
                c_char_p(b"application"),
                c_char_p(value.encode()),
            )
            return pw.decode("utf-8", "replace") if pw else None
        except Exception:
            return None


KEYRING = Keyring()


def pbkdf2_key(password: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha1", password.encode(), b"saltysalt", 1, 16)


def decrypt_v10(ciphertext: bytes, key: bytes) -> bytes:
    from ctypes import byref, create_string_buffer, c_int

    crypto = KEYRING.crypto
    iv = b" " * 16
    ctx = crypto.EVP_CIPHER_CTX_new()
    crypto.EVP_DecryptInit_ex(ctx, crypto.EVP_aes_128_cbc(), None, key, iv)
    crypto.EVP_CIPHER_CTX_set_padding(ctx, 0)
    out = create_string_buffer(len(ciphertext) + 32)
    outn = c_int()
    crypto.EVP_DecryptUpdate(ctx, out, byref(outn), ciphertext, len(ciphertext))
    fin = create_string_buffer(32)
    finn = c_int()
    crypto.EVP_DecryptFinal_ex(ctx, fin, byref(finn))
    return out.raw[: outn.value] + fin.raw[: finn.value]


def strip_padding(plaintext: bytes) -> bytes:
    return plaintext.rstrip(b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10").rstrip(b"\r\n \t")


def read_cookie_rows(db_path: str):
    """Copy the locked cookie DB to a temp file and read deepseek rows."""
    with tempfile.TemporaryDirectory() as tmp:
        workdb = os.path.join(tmp, os.path.basename(db_path))
        shutil.copy2(db_path, workdb)
        for suffix in ("-wal", "-shm"):
            try:
                shutil.copy2(db_path + suffix, workdb + suffix)
            except OSError:
                pass
        con = sqlite3.connect(workdb)
        try:
            yield from con.execute(
                "SELECT name, value, encrypted_value FROM cookies WHERE host_key LIKE '%deepseek%'"
            )
        finally:
            con.close()


def read_firefox_rows(db_path: str):
    with tempfile.TemporaryDirectory() as tmp:
        workdb = os.path.join(tmp, "cookies.sqlite")
        shutil.copy2(db_path, workdb)
        for suffix in ("-wal", "-shm"):
            try:
                shutil.copy2(db_path + suffix, workdb + suffix)
            except OSError:
                pass
        con = sqlite3.connect(workdb)
        try:
            yield from con.execute(
                "SELECT name, value, NULL FROM moz_cookies WHERE host LIKE '%deepseek%'"
            )
        finally:
            con.close()


def key_for_browser(label: str) -> bytes:
    pw = KEYRING.password("chrome_libsecret_os_crypt_password_v2", "chrome")
    if not pw:
        pw = KEYRING.password("chrome_libsecret_chrome_password_schema_2", "chrome")
    if pw:
        return pbkdf2_key(pw)
    # Chrome on Linux falls back to the well-known "peanuts" password when the
    # keyring is unavailable.
    return pbkdf2_key("peanuts")


def search_chrome():
    hits = []
    for label, pattern in CHROME_CANDIDATES.items():
        for db in glob.glob(os.path.expanduser(pattern)):
            try:
                key = key_for_browser(label)
                for name, value, encrypted in read_cookie_rows(db):
                    if name != COOKIE_NAME:
                        continue
                    if value:
                        hits.append(value)
                        continue
                    if not encrypted:
                        continue
                    data = encrypted[3:] if encrypted[:3] in (b"v10", b"v11") else encrypted
                    token = strip_padding(decrypt_v10(data, key)).decode("utf-8", "replace")
                    if len(token) >= 16:
                        hits.append(token)
            except Exception as e:
                print(f"  ! {db}: {e}", file=sys.stderr)
    return hits


def search_firefox():
    hits = []
    for pattern in FIREFOX_GLOBS:
        for db in glob.glob(os.path.expanduser(pattern)):
            try:
                for name, value, _ in read_firefox_rows(db):
                    if name == COOKIE_NAME and value and len(value) >= 16:
                        hits.append(value)
            except Exception as e:
                print(f"  ! {db}: {e}", file=sys.stderr)
    return hits


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    write = "--write" in sys.argv
    which = args[0] if args else "all"

    tokens = []
    if which in ("all", "chrome", "chromium"):
        tokens += search_chrome()
    if which in ("all", "firefox"):
        tokens += search_firefox()

    unique = list(dict.fromkeys(tokens))
    if not unique:
        print(
            "No DeepSeek userToken found.\n"
            "Open https://chat.deepseek.com in your default browser profile and confirm you\n"
            "are logged in (cookies written), then re-run this script.\n\n"
            "Manual fallback: DevTools > Application > Cookies > userToken",
            file=sys.stderr,
        )
        return 1

    token = unique[0]
    print(token)
    if len(unique) > 1:
        print(f"(note: {len(unique)} distinct tokens found; using the first)", file=sys.stderr)

    if write:
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        outdir = os.path.join(xdg, "opencode", "deepseek-web")
        os.makedirs(outdir, exist_ok=True)
        out = os.path.join(outdir, "token.json")
        with open(out, "w") as fh:
            json.dump({"token": token}, fh)
        print(f"Wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
