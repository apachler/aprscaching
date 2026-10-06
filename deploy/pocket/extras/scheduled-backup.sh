#!/usr/bin/env bash
# The backup Android's job scheduler runs (extras/setup.sh --scheduled-backup registers it): daily, only
# while the phone charges. It also checks the battery is above 50 %, runs backup.sh, records the time in
# ~/.aprscaching/run/last-backup, and shows a short toast with the result.
#
# Options:
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
mkdir -p "$RUN_DIR" "$LOG_DIR"
LOG="$LOG_DIR/scheduled-backup.log"
MIN_BATTERY="${APRSCACHING_BACKUP_MIN_BATTERY:-50}"

say() { printf '%(%Y-%m-%d %H:%M:%S)T %s\n' -1 "$*" >>"$LOG"; }
toast() { if have termux-toast; then termux_api termux-toast -s "$1" || true; fi; }

pct=""
if battery="$(termux_api termux-battery-status)" && [ -n "$battery" ]; then
  pct="$(printf '%s' "$battery" | json_field percentage)"
fi
if [ -n "$pct" ] && [ "$pct" -lt "$MIN_BATTERY" ]; then
  say "skipped: battery ${pct}% is below ${MIN_BATTERY}%"
  exit 0
fi
if bash "$HERE/backup.sh" --dir "$DIR" --data-dir "$DATA" >>"$LOG" 2>&1; then
  date +%s >"$RUN_DIR/last-backup"
  say "backup done"
  toast "APRScaching backup done"
else
  say "backup FAILED (see above)"
  toast "APRScaching backup failed: see $LOG"
  exit 1
fi
