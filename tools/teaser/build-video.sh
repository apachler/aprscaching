#!/usr/bin/env bash
# Assemble the multi-viewport UI tour frames into an ordered, captioned teaser video.
# Composition runs in Chromium (canvas + MediaRecorder) — see compose.mjs — because the
# Playwright-bundled ffmpeg is a minimal screencast build (no PNG decode, no drawtext/fade).
# Output: tour/aprscaching-ui-teaser.webm
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
if [ -z "${PW_CHROMIUM:-}" ]; then
  for c in /opt/pw-browsers/chromium-*/chrome-linux/chrome; do [ -x "$c" ] && export PW_CHROMIUM="$c" && break; done
fi
exec node "$HERE/compose.mjs"
