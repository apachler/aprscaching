#!/usr/bin/env bash
set -euo pipefail
# Start a built desktop binary and check what it serves from its embedded build: /health, the web app at / with
# its page headers, a 404 for a missing asset, and every WebAssembly module of the web build (Direwolf's modem
# among them) byte for byte, as application/wasm and compiling under WebAssembly.compileStreaming, which
# refuses any other type.
# Needs Node and curl; runs the binary on a free loopback port with a throwaway data directory.
# Usage: bash deploy/desktop/smoke.sh dist/desktop/aprscaching-linux-x64 [apps/web/dist]
BIN="${1:?usage: smoke.sh BINARY [WEB_DIST]}"
WEB="${2:-apps/web/dist}"
[ -x "$BIN" ] || { echo "FAIL  $BIN is not an executable" >&2; exit 1; }
[ -f "$WEB/index.html" ] || { echo "FAIL  $WEB is not the web build the binary embeds" >&2; exit 1; }
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

WORK="$(mktemp -d)"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
# Run it from an empty directory, so nothing beside it can stand in for the embedded files.
(cd "$WORK" && exec env -i PATH="$PATH" HOME="$WORK" DATA_DIR="$WORK/data" PORT="$PORT" \
  APP_URL="http://127.0.0.1:$PORT" "$BIN") >"$WORK/out.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT
fail() {
  echo "FAIL  $*" >&2
  tail -n 30 "$WORK/out.log" >&2 || true
  exit 1
}
ok() { printf 'ok    %s\n' "$*"; }

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 "$BASE/health" 2>/dev/null && break
  kill -0 "$PID" 2>/dev/null || fail "the binary exited"
  sleep 0.5
done
curl -fsS -o /dev/null --max-time 5 "$BASE/health" || fail "/health"
grep -q "embedded assets" "$WORK/out.log" || fail "the binary did not serve its embedded build"
ok "the binary answers /health from its embedded build"
page="$(curl -fsS --max-time 5 "$BASE/")" || fail "the web app at /"
grep -qi "<html" <<<"$page" || fail "the web app at / is not the web app"
ok "it serves the web app"
head="$(curl -fsS -o /dev/null -D - --max-time 5 "$BASE/" | tr -d '\r')"
grep -qi "^x-frame-options: SAMEORIGIN$" <<<"$head" || fail "the web app at / without its page headers"
grep -qi "^cache-control: no-cache$" <<<"$head" || fail "the web app at / is cacheable"
ok "with the page headers, revalidated on every load"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/assets/missing-000.js")"
[ "$code" = 404 ] || fail "a missing asset answers $code, not 404"
miss="$(curl -sS -o /dev/null -D - --max-time 5 "$BASE/assets/missing-000.js" | tr -d '\r')"
grep -qi "^cache-control: no-store$" <<<"$miss" || fail "a missing asset answers a 404 a cache may keep"
ok "a missing asset is a 404, never cached"

n=0
while IFS= read -r -d '' f; do
  p="/${f#"$WEB"/}"
  node -e '
    const [url, file] = process.argv.slice(1);
    const want = require("fs").readFileSync(file);
    (async () => {
      const res = await fetch(url);
      const type = res.headers.get("content-type");
      if (type !== "application/wasm") throw new Error(`content-type ${type}`);
      const got = Buffer.from(await res.clone().arrayBuffer());
      if (!got.equals(want)) throw new Error("the bytes differ from the build");
      await WebAssembly.compileStreaming(res);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$BASE$p" "$f" || fail "$p"
  ok "$p: application/wasm, compiles"
  n=$((n + 1))
done < <(find "$WEB" -type f -name '*.wasm' -print0)
ok "$n WebAssembly module(s) served"
