#!/usr/bin/env bash
# Run the UI tour for each viewport sequentially against already-running servers.
# Each viewport is its own node process; tour.mjs closes its own browser, so no external kill is
# needed (an external pkill on the chrome path also matches THIS script's own command line — that
# self-kill was the earlier failure). Frames land in tour/.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
for c in /opt/pw-browsers/chromium-*/chrome-linux/chrome; do [ -x "$c" ] && export PW_CHROMIUM="$c" && break; done
BASE="${BASE:-http://127.0.0.1:4199}"
echo "chrome: $PW_CHROMIUM ; base: $BASE"
rm -f tour/[123]-*.png tour/manifest-*.json 2>/dev/null || true
rc=0
for VIEW in desktop tablet mobile; do
  echo "=== $VIEW ==="
  if ! BASE="$BASE" OUT="$HERE/tour/" VIEW="$VIEW" node tour.mjs 2>&1; then
    echo "($VIEW exited non-zero — continuing)"; rc=1
  fi
  sleep 2
done
echo "=== frame count: $(ls tour/[123]-*.png 2>/dev/null | wc -l) ==="
exit $rc