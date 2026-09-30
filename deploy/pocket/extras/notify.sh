#!/usr/bin/env bash
# One ongoing Android notification for the station, kept current every 60 s: running or stopped, the
# stations heard in the last hour, when the MeshCom node was last heard, whether APRS-IS delivers, and the
# battery. Its buttons stop or restart the station and open the map; tapping it opens the map too.
# start.sh runs it in the tmux window `notify` when the Termux:API app answers; stop.sh removes the
# notification. Without Termux:API it prints one line saying what to install and exits.
#
#   bash ~/aprscaching/deploy/pocket/extras/notify.sh            # every 60 s until the station stops
#   bash ~/aprscaching/deploy/pocket/extras/notify.sh --once     # one update
#   bash ~/aprscaching/deploy/pocket/extras/notify.sh --remove
#
# Options:
#   --once               update the notification once and exit
#   --remove             remove the notification
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

MODE=loop
while [ $# -gt 0 ]; do
  case "$1" in
    --once) MODE=once ;;
    --remove) MODE=remove ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

ID=aprscaching
INTERVAL="${APRSCACHING_NOTIFY_S:-60}"

if [ "$MODE" = remove ]; then
  if have termux-notification-remove; then termux_api termux-notification-remove "$ID" || true; fi
  exit 0
fi
if ! termux_api_ready; then
  termux_api_hint "the station notification"
  exit 0
fi

# The notification's lines, from the gateway's station summary and the battery.
compose() {
  local status body battery line
  if status="$(station_status "")" && [ -n "$status" ]; then
    TITLE="aprscaching: running"
    # shellcheck disable=SC2016 # JavaScript template literals, not shell
    body="$(printf '%s' "$status" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const j = JSON.parse(s), out = [], now = j.now;
        out.push(`${j.stationsLastHour} stations heard in the last hour`);
        const port = (n) => j.ports.find((p) => p.port === n);
        const mc = port("meshcom"), is = port("aprs-is");
        const since = (t) => { const d = now - t; return d < 90 ? `${d} s` : d < 5400 ? `${Math.round(d / 60)} min` : `${Math.round(d / 3600)} h`; };
        if (mc) out.push(mc.lastHeard && now - mc.lastHeard < 900 ? `MeshCom heard ${since(mc.lastHeard)} ago` : `MeshCom silent${mc.lastHeard ? " " + since(mc.lastHeard) : ""}`);
        if (is) out.push(is.lastHeard && now - is.lastHeard < 300 ? "APRS-IS live" : "APRS-IS quiet (offline?)");
        process.stdout.write(out.join(" · "));
      });')"
  else
    TITLE="aprscaching: stopped"
    body="the gateway does not answer on $(gateway_base)"
  fi
  if battery="$(termux_api termux-battery-status)" && [ -n "$battery" ]; then
    line="battery $(printf '%s' "$battery" | json_field percentage)%"
    [ "$(printf '%s' "$battery" | json_field plugged)" = UNPLUGGED ] || line="$line, charging"
    body="$body · $line"
  fi
  CONTENT="$body"
}

# The buttons run in Termux; paths are quoted for the shell that runs them.
q() { printf '%q' "$1"; }
paths="APRSCACHING_DIR=$(q "$DIR") APRSCACHING_DATA=$(q "$DATA")"
MAP="http://localhost:$(gateway_port)"

update() {
  compose
  termux_api termux-notification --id "$ID" --ongoing --alert-once --priority low \
    --title "$TITLE" --content "$CONTENT" \
    --action "termux-open-url $MAP" \
    --button1 "Stop" --button1-action "$paths bash $(q "$HERE/stop.sh")" \
    --button2 "Restart" --button2-action "$paths bash $(q "$HERE/restart.sh")" \
    --button3 "Open map" --button3-action "termux-open-url $MAP" >/dev/null || true
}

update
[ "$MODE" = loop ] || exit 0
while sleep "$INTERVAL"; do
  update
done
