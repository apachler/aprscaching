#!/usr/bin/env bash
# Regenerate the manual's screenshots (docs/assets/shots/) from the live app: runs the UI tour on the
# desktop and mobile viewports against a fresh seeded instance, then converts the frames the guides use
# to compact WebP. Re-run whenever the UI changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
( cd "$HERE" && [ -d node_modules ] || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund )
rc=0
SKIP_VIDEO=1 bash "$HERE/run-tour.sh" desktop mobile || rc=$?
# 1 = some tour steps were skipped: the frames that exist are still usable; docs-shots.mjs fails on any
# frame the manual needs that is missing.
[ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || exit "$rc"
( cd "$HERE" && FRAMES="$HERE/tour" DEST="$ROOT/docs/assets/shots" node docs-shots.mjs )
