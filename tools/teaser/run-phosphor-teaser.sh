#!/usr/bin/env bash
# Phosphor desktop teaser = the full signed-in UI tour, desktop viewport, captured in the green-phosphor
# flip. Thin wrapper over run-tour.sh so we reuse its real email-dev-link sign-in, runtime rail
# discovery, and the (hardened) Settings collapse-group walkthrough — captureGroups() collapses every
# group first and after each shot, so exactly ONE group is open per frame.
#
# Output (from run-tour.sh): tools/teaser/tour/aprscaching-ui-teaser.webm  + 1-*.png desktop frames.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "==> Phosphor desktop teaser (THEME=phosphor, desktop viewport)"
THEME=phosphor exec bash "$HERE/run-tour.sh" desktop
