#!/usr/bin/env bash
# Build the web app (offline basemap), start the Node gateway + seed demo data, serve the SPA, and run
# the full multi-viewport UI tour. Frames land in tools/teaser/tour/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/tour"
PORT_API="${PORT_API:-8799}"
PORT_WEB="${PORT_WEB:-4199}"
# Which viewports to capture. Default all three; pass a subset to save time, e.g.
#   tools/teaser/run-tour.sh desktop        (desktop only)
#   tools/teaser/run-tour.sh desktop mobile
VIEWS="${*:-desktop tablet mobile}"
for v in $VIEWS; do case "$v" in desktop|tablet|mobile) ;; *) echo "unknown viewport: $v (use desktop|tablet|mobile)"; exit 2 ;; esac; done
DB="$(mktemp -d)/teaser.db"
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
for c in /opt/pw-browsers/chromium-*/chrome-linux/chrome /opt/pw-browsers/chromium/chrome-linux/chrome; do [ -x "$c" ] && export PW_CHROMIUM="$c" && break; done
mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT"/manifest*.json "$OUT"/problems*.json 2>/dev/null || true

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
# Per-viewport exit codes: 0 = clean, 4 = some steps skipped (video still builds), other = the tour
# process crashed. Recorded here and reported in the problem summary so a full run surfaces failures.
declare -a VIEW_RC=()
echo "==> viewports: $VIEWS"
for VIEW in $VIEWS; do
  echo "   -- $VIEW"
  rc=0
  ( cd "$HERE" && BASE="http://127.0.0.1:$PORT_WEB" API_BASE="http://127.0.0.1:$PORT_API" OUT="$OUT/" VIEW="$VIEW" node tour.mjs ) || rc=$?
  VIEW_RC+=("$VIEW=$rc")
  [ "$rc" -ne 0 ] && echo "   ($VIEW exited $rc — details in the problem summary below)"
  sleep 2
done

echo "==> tour frames in $OUT: $(ls "$OUT"/[123]-*.png 2>/dev/null | wc -l)"

echo "==> assemble the captioned teaser video"
bash "$HERE/build-video.sh" || { echo "   (compose hiccup — retrying once)"; sleep 2; bash "$HERE/build-video.sh"; }

# ---- problem summary: aggregate the per-viewport problems-*.json into one findable report ----
# A full run must end with an unmissable list of what (if anything) failed, plus per-viewport exit
# codes. Exits non-zero when any step was skipped or a viewport crashed — the video is already built.
echo "==> problem summary"
PROBLEMS=0
node - "$OUT" <<'NODE' || PROBLEMS=$?
const fs = require("fs"), dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^problems-.*\.json$/.test(f));
let all = [];
for (const f of files) { try { all.push(...JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"))); } catch {} }
if (!all.length) { console.log("   ✓ no problems — every scripted step captured on all viewports"); process.exit(0); }
console.log(`   ✗ ${all.length} step(s) skipped across viewports:`);
for (const p of all) console.log(`     - ${p.viewport}/${p.step} — ${p.reason}`);
process.exit(1);
NODE
CRASHED=0
for entry in "${VIEW_RC[@]}"; do
  v="${entry%=*}"; rc="${entry#*=}"
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 4 ]; then echo "   ✗ viewport '$v' crashed (exit $rc) — its tour did not finish"; CRASHED=1; fi
done

echo "==> teaser complete: $OUT/aprscaching-ui-teaser.webm"
if [ "$PROBLEMS" -ne 0 ] || [ "$CRASHED" -ne 0 ]; then
  echo "==> FINISHED WITH PROBLEMS (video built, but some steps were skipped — see summary above)"
  exit 1
fi
