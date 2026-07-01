#!/usr/bin/env bash
# Build the web app (offline basemap), start the Node gateway + seed demo data, serve the SPA, and run
# the full multi-viewport UI tour. Frames land in tools/teaser/tour/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/tour"
PORT_API="${PORT_API:-8799}"
PORT_WEB="${PORT_WEB:-4199}"
DB="$(mktemp -d)/teaser.db"
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
for c in /opt/pw-browsers/chromium-*/chrome-linux/chrome /opt/pw-browsers/chromium/chrome-linux/chrome; do [ -x "$c" ] && export PW_CHROMIUM="$c" && break; done
mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT"/manifest.json 2>/dev/null || true

cleanup() { for p in ${API_PID:-} ${WEB_PID:-}; do kill -9 "-$p" 2>/dev/null || true; done; pkill -9 -f "src/server.ts" 2>/dev/null || true; pkill -9 -f "vite preview" 2>/dev/null || true; }
trap cleanup EXIT
wait_url() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

echo "==> build web (offline grid basemap, api -> :$PORT_API)"
( cd "$ROOT" && VITE_BASEMAP=offline VITE_API_BASE="http://127.0.0.1:$PORT_API" pnpm --filter @aprsweb/web build ) >/dev/null

echo "==> start Node gateway on :$PORT_API"
pkill -9 -f "src/server.ts" 2>/dev/null || true; sleep 1
setsid bash -c "DB_PATH='$DB' PORT=$PORT_API INSTANCE=oe.teaser FED_PRIVATE_KEY='' exec pnpm --filter @aprsweb/node-gateway start" >"$OUT/api.log" 2>&1 &
API_PID=$!
wait_url "http://127.0.0.1:$PORT_API/health" || { echo "gateway did not start"; tail "$OUT/api.log"; exit 1; }

echo "==> seed demo data"
( cd "$HERE" && API_BASE="http://127.0.0.1:$PORT_API" node seed.mjs ) || true

echo "==> serve SPA on :$PORT_WEB"
setsid bash -c "cd '$ROOT/apps/web' && exec npx vite preview --port $PORT_WEB --host 127.0.0.1" >"$OUT/web.log" 2>&1 &
WEB_PID=$!
wait_url "http://127.0.0.1:$PORT_WEB/" || { echo "preview did not start"; tail "$OUT/web.log"; exit 1; }

echo "==> run the UI tour (one node process per viewport; tour.mjs closes its own browser)"
# NOTE: do NOT pkill on the chrome path here — that pattern also matches this script's own command
# line and would kill the orchestrator mid-loop. Playwright's browser.close() in tour.mjs is enough.
for VIEW in desktop tablet mobile; do
  echo "   -- $VIEW"
  ( cd "$HERE" && BASE="http://127.0.0.1:$PORT_WEB" OUT="$OUT/" VIEW="$VIEW" node tour.mjs ) || echo "   ($VIEW had errors — continuing)"
  sleep 2
done

echo "==> tour frames in $OUT: $(ls "$OUT"/[123]-*.png 2>/dev/null | wc -l)"

echo "==> assemble the captioned teaser video"
bash "$HERE/build-video.sh" || { echo "   (compose hiccup — retrying once)"; sleep 2; bash "$HERE/build-video.sh"; }

echo "==> teaser complete: $OUT/aprscaching-ui-teaser.webm"
