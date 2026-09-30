#!/usr/bin/env bash
# Battery saver: while the phone runs on battery below POCKET_BATTERY_LOW percent (default 20), the station
# switches to a saver profile, and back once the phone charges or the battery is 10 points above the
# threshold again (the gap keeps it from flapping). The saver profile
#
#   - narrows the APRS-IS feed to your own call's packets (APRSIS_FILTER=b/<CALL>*), so almost no data
#     flows; the connection itself stays up;
#   - keeps the MeshCom listener and every radio port as they are;
#   - keeps the raw packet log 2 hours instead of the profile's 6 (RETENTION).
#
# It is an overlay (~/.aprscaching/battery-saver.env) the processes load after the .env, applied with a
# restart of both; removing it and restarting again restores the normal profile. One notification says so
# each time it switches. start.sh runs it in the tmux window `battery` when the Termux:API app answers;
# POCKET_BATTERY_LOW=0 in the .env turns it off.
#
#   bash ~/aprscaching/deploy/pocket/extras/battery.sh             # check every 2 minutes
#   bash ~/aprscaching/deploy/pocket/extras/battery.sh --once      # check once
#   bash ~/aprscaching/deploy/pocket/extras/battery.sh --decide PERCENT CHARGING PROFILE
#                                                                  # print the profile the rule picks
#
# Options:
#   --once               check once and exit
#   --decide P C PROF    the rule alone: P percent, C 1 while charging, PROF normal|saver
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

MODE=loop
DECIDE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --once) MODE=once ;;
    --decide) MODE=decide; DECIDE=("${2:-}" "${3:-}" "${4:-}"); shift 3 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

# The rule: saver below LOW on battery; normal again when charging or at LOW + 10.
decide() {
  local pct=$1 charging=$2 profile=$3 low=$4
  if [ "$profile" = saver ]; then
    if [ "$charging" = 1 ] || [ "$pct" -ge $((low + 10)) ]; then echo normal; else echo saver; fi
  else
    if [ "$charging" != 1 ] && [ "$pct" -lt "$low" ]; then echo saver; else echo normal; fi
  fi
}

LOW="$(env_get POCKET_BATTERY_LOW)"
LOW="${LOW:-20}"
case "$LOW" in '' | *[!0-9]*) die "POCKET_BATTERY_LOW must be a percentage (got '$LOW')." ;; esac

if [ "$MODE" = decide ]; then
  decide "${DECIDE[0]}" "${DECIDE[1]}" "${DECIDE[2]}" "$LOW"
  exit 0
fi
if [ "$LOW" -eq 0 ]; then
  info "battery saver off (POCKET_BATTERY_LOW=0)"
  exit 0
fi
if ! termux_api_ready; then
  termux_api_hint "the battery saver"
  exit 0
fi

current() { if [ -f "$SAVER_ENV" ]; then echo saver; else echo normal; fi; }

notify_once() {
  if have termux-notification; then
    termux_api termux-notification --id aprscaching-battery --title "aprscaching: $1" --content "$2" >/dev/null || true
  fi
}

apply() {
  local to=$1 pct=$2 call
  if [ "$to" = saver ]; then
    call="$(env_get APRSIS_CALLSIGN)"
    call="${call:-$(env_get ADMIN_CALLSIGNS)}"
    call="${call%%,*}"
    call="${call%%-*}"
    umask 077
    {
      printf '# Written by extras/battery.sh while the battery is low; removed when it recovers.\n'
      printf "APRSIS_FILTER='b/%s*'\n" "${call:-N0CALL}"
      printf "RETENTION='{\"packetsHours\":2,\"sensorDays\":7,\"portStatsDays\":3,\"mheardDays\":3}'\n"
    } >"$SAVER_ENV"
    info "battery ${pct}%: saver profile on (APRS-IS narrowed to ${call:-your call}, raw log 2 h)"
    notify_once "battery saver on" "Battery ${pct}%: APRS-IS narrowed to your own call until the phone charges."
  else
    rm -f "$SAVER_ENV"
    info "battery ${pct}%: normal profile again"
    notify_once "battery saver off" "Battery ${pct}%: the normal profile is back."
  fi
  if session_exists; then restart_station >/dev/null || true; fi
}

check() {
  local battery pct plugged charging want
  battery="$(termux_api termux-battery-status)" || return 0
  [ -n "$battery" ] || return 0
  pct="$(printf '%s' "$battery" | json_field percentage)"
  plugged="$(printf '%s' "$battery" | json_field plugged)"
  case "$pct" in '' | *[!0-9]*) return 0 ;; esac
  charging=1
  [ "$plugged" != UNPLUGGED ] || charging=0
  want="$(decide "$pct" "$charging" "$(current)" "$LOW")"
  [ "$want" = "$(current)" ] || apply "$want" "$pct"
}

check
[ "$MODE" = loop ] || exit 0
while sleep "${APRSCACHING_BATTERY_S:-120}"; do
  check
done
