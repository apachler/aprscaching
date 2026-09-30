#!/usr/bin/env bash
# Field alerts: a new direct message to your call (MeshCom or APRS, any SSID of ADMIN_CALLSIGNS) makes the
# phone vibrate and, optionally, say who it is from ("Message from OE8XYZ"). It asks the gateway's
# /api/admin/station-status every 15 seconds for messages after the last one it announced (its time and
# id, in ~/.aprscaching/run/alerts.since), so each message is announced once, also across restarts.
# Message bodies are spoken only with POCKET_ALERTS_SPEAK_BODY=1: they may be private, and a phone speaks
# them to everyone around it.
#
# Off by default. POCKET_ALERTS=1 in the .env turns it on (vibrate); POCKET_ALERTS_SPEAK=1 adds speech;
# start.sh then runs it in the tmux window `alerts` when the Termux:API app answers.
#
#   bash ~/aprscaching/deploy/pocket/extras/alerts.sh           # poll every 15 s
#   bash ~/aprscaching/deploy/pocket/extras/alerts.sh --once    # check once
#
# Options:
#   --once               check once and exit
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

ONCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

if [ "$(env_get POCKET_ALERTS)" != 1 ]; then
  info "field alerts off (POCKET_ALERTS=1 in $ENV_FILE turns them on)"
  exit 0
fi
if ! termux_api_ready; then
  termux_api_hint "field alerts"
  exit 0
fi
SPEAK="$(env_get POCKET_ALERTS_SPEAK)"
SPEAK_BODY="$(env_get POCKET_ALERTS_SPEAK_BODY)"
SINCE_FILE="$RUN_DIR/alerts.since"
mkdir -p "$RUN_DIR"
# "time id" of the last message announced. The first run starts now: older messages were there before
# alerts were on.
[ -s "$SINCE_FILE" ] || printf '%s 0\n' "$(date +%s)" >"$SINCE_FILE"

# One line per new message, "ts<TAB>id<TAB>from<TAB>body", oldest first. The query starts a second before
# the last one announced, and the id skips what was announced already: two messages in one second both
# arrive.
new_messages() {
  local ts id
  read -r ts id <"$SINCE_FILE"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell
  station_status "$((ts - 1))" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const after = Number(process.argv[1]), since = Number(process.argv[2]);
        for (const m of JSON.parse(s).messages ?? []) {
          if (m.ts < since || (m.ts === since && m.id <= after)) continue;
          process.stdout.write(`${m.ts}\t${m.id}\t${String(m.from).replace(/\s/g, "")}\t${String(m.body ?? "").replace(/[\t\n\r]/g, " ")}\n`);
        }
      } catch {}
    });' "$id" "$ts"
}

# Spell a callsign for speech: "O E 8 X Y Z" reads better than a word guess.
spell() { printf '%s' "$1" | sed -e 's/-.*//' -e 's/./& /g' -e 's/ $//'; }

check() {
  local ts id from body text
  while IFS=$'\t' read -r ts id from body; do
    [ -n "$ts" ] || continue
    info "message from $from"
    termux_api termux-vibrate -d 600 >/dev/null || true
    if [ "$SPEAK" = 1 ] && have termux-tts-speak; then
      text="Message from $(spell "$from")"
      if [ "$SPEAK_BODY" = 1 ]; then text="$text. $body"; fi
      termux_api termux-tts-speak "$text" >/dev/null || true
    fi
    printf '%s %s\n' "$ts" "$id" >"$SINCE_FILE"
  done < <(new_messages)
}

check
[ "$ONCE" -eq 0 ] || exit 0
while sleep "${APRSCACHING_ALERTS_S:-15}"; do
  check
done
