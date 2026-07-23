#!/usr/bin/env bash
# One-shot teaser builder: build (offline basemap) -> worker+D1 -> preview -> seed -> crawl -> poster.
# Output: tools/teaser/out/{01-map,02-detail,03-hide,04-mobile,teaser}.png
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$HERE/out}"
PORT_API="${PORT_API:-8787}"
PORT_WEB="${PORT_WEB:-4173}"
# In this sandbox Chromium lives at /opt/pw-browsers; elsewhere `npx playwright install chromium`
# and leave PW_CHROMIUM unset so Playwright resolves its own download.
export PW_CHROMIUM="${PW_CHROMIUM:-/opt/pw-browsers/chromium}"
[ -x "$PW_CHROMIUM" ] || unset PW_CHROMIUM
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
mkdir -p "$OUT"

cleanup() { pkill -f "wrangler dev" 2>/dev/null || true; pkill -f "vite preview" 2>/dev/null || true; pkill -f workerd 2>/dev/null || true; }
trap cleanup EXIT
wait_url() { for _ in $(seq 1 40); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

echo "==> deps (teaser)"
( cd "$HERE" && if [ ! -d node_modules ]; then
    # a prebuilt Chromium (PW_CHROMIUM) means we don't need Playwright's own download
    [ -n "${PW_CHROMIUM:-}" ] && export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    npm install
  fi )

echo "==> build web (offline grid basemap)"
( cd "$ROOT" && VITE_BASEMAP=offline pnpm --filter @aprscaching/web build )

echo "==> reset local D1 + start worker"
cleanup; sleep 1
( cd "$ROOT/workers/gateway" && rm -rf .wrangler && CI=1 npx wrangler d1 migrations apply aprscaching --local )
# Tier A is default-deny; the demo seed gates its RF find through OE8XXX, so attest it so the teaser
# logbook shows the intended Tier-A (RF) entry.
( cd "$ROOT/workers/gateway" && CI=1 npx wrangler dev --port "$PORT_API" --local --ip 127.0.0.1 --var FIRST_PARTY_SITES:OE8XXX ) >"$OUT/wrangler.log" 2>&1 &
wait_url "http://127.0.0.1:$PORT_API/health" || { echo "worker did not start"; exit 1; }

echo "==> start web preview"
( cd "$ROOT/apps/web" && npx vite preview --port "$PORT_WEB" --host 127.0.0.1 ) >"$OUT/vite.log" 2>&1 &
wait_url "http://127.0.0.1:$PORT_WEB/" || { echo "preview did not start"; exit 1; }

echo "==> seed demo data"
( cd "$HERE" && API_BASE="http://127.0.0.1:$PORT_API" node seed.mjs )

echo "==> crawl screenshots"
( cd "$HERE" && BASE="http://127.0.0.1:$PORT_WEB" OUT="$OUT" node shoot.mjs )

echo "==> stage brand assets + compose poster"
cp "$ROOT/apps/web/public/brand/wordmark.png" "$ROOT/apps/web/public/brand/bg.jpg" "$OUT/"
cp "$ROOT/apps/web/public/fonts/Fredoka-500.woff2" "$ROOT/apps/web/public/fonts/Fredoka-700.woff2" "$OUT/"
cp "$HERE/teaser.html" "$OUT/"
( cd "$HERE" && OUT="$OUT" node teaser.mjs )

echo "==> done: $OUT/teaser.png"
