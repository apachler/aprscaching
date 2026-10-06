#!/usr/bin/env bash
# Start the Pocket station in the tmux session `aprscaching`, or attach to it when it already runs.
# Windows: gateway (servers/node) · ingest (apps/ingest) · tls (with https on, tls.sh --watch) · usb-kiss
# (a USB TNC), notify, alerts and battery (with Termux:API, the extras/ scripts) · logs · shell. The gateway and the ingest run under supervise.sh, which restarts either one
# after a short backoff when it exits and writes its output to ~/.aprscaching/logs/. A wake lock keeps
# the phone's CPU running while Termux is in the background (termux-wake-lock; stop.sh releases it).
#
#   bash ~/aprscaching/deploy/pocket/start.sh
#   bash ~/aprscaching/deploy/pocket/start.sh --no-attach --gateway-only
#
# In the session: Ctrl-b then a window number switches windows, Ctrl-b d detaches and leaves the
# station running. stop.sh stops it.
#
# Options:
#   --no-attach          start (or complete) the session without attaching; waits for /health
#   --gateway-only       no ingest window (no MeshCom node and no APRS-IS feed)
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

ATTACH=1
INGEST=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-attach) ATTACH=0 ;;
    --gateway-only) INGEST=0 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

have tmux || die "tmux is missing." "Install it with:  pkg install tmux"
have node || die "node is missing." "Run deploy/pocket/install.sh first."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."
[ -f "$DIR/servers/node/src/server.ts" ] || die "$DIR is not an APRScaching checkout." "Pass --dir PATH."
mkdir -p "$LOG_DIR" "$RUN_DIR"

BASE="$(gateway_base)"
if ! session_exists && health_ok "$BASE"; then
  warn "a gateway outside this session already answers on $BASE; the supervised one cannot bind the port" \
    "until that one stops."
fi

if have termux-wake-lock; then
  termux-wake-lock || true
  info "wake lock taken (stop.sh releases it)"
fi

# The command a window runs. tmux passes it to a shell, so every path is quoted.
q() { printf '%q' "$1"; }
supervised() {
  printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s %s' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/supervise.sh")" "$1"
}
logs_cmd() {
  local files
  files="$(q "$LOG_DIR/gateway.log")"
  [ "$INGEST" -eq 0 ] || files="$files $(q "$LOG_DIR/ingest.log")"
  printf 'touch %s; tail -n 50 -F %s' "$files" "$files"
}

# Add a window unless the session already has one of that name (a window closes when its command ends).
ensure_window() {
  local name=$1 cmd=${2:-}
  if ! session_exists; then
    if [ -n "$cmd" ]; then
      tmux new-session -d -s "$SESSION" -n "$name" -c "$DIR" "$cmd"
    else
      tmux new-session -d -s "$SESSION" -n "$name" -c "$DIR"
    fi
    info "session $SESSION: window $name"
  elif ! tmux list-windows -t "=$SESSION" -F '#{window_name}' | grep -qxF "$name"; then
    if [ -n "$cmd" ]; then
      tmux new-window -d -t "=$SESSION:" -n "$name" -c "$DIR" "$cmd"
    else
      tmux new-window -d -t "=$SESSION:" -n "$name" -c "$DIR"
    fi
    info "session $SESSION: window $name"
  fi
}

# https for visitors (tls.sh): the certificate must cover the current addresses before the gateway loads
# it, and the window tls keeps it current while the station runs.
HTTPS="$(tls_port)"
if [ -n "$HTTPS" ]; then
  APRSCACHING_DIR="$DIR" APRSCACHING_DATA="$DATA" bash "$HERE/tls.sh" --renew --quiet ||
    warn "the https certificate could not be renewed; see: bash $HERE/tls.sh --renew"
fi

step "Starting the station (tmux session $SESSION)"
already=0
session_exists && already=1
ensure_window gateway "$(supervised gateway)"
if [ "$INGEST" -eq 1 ]; then ensure_window ingest "$(supervised ingest)"; fi
if [ -n "$HTTPS" ]; then
  ensure_window tls "$(printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s --watch' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/tls.sh")")"
fi
# The station notification (extras/notify.sh) when the Termux:API app answers.
if have termux-notification && termux_api_ready; then
  ensure_window notify "$(printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/extras/notify.sh")")"
elif ! session_exists || ! tmux list-windows -t "=$SESSION" -F '#{window_name}' | grep -qxF notify; then
  termux_api_hint "the station notification"
fi
# The USB KISS TNC bridge (extras/usb-kiss.sh) once usb-kiss.sh --setup has chosen a device.
if [ -n "$(env_get USB_KISS_DEVICE)" ]; then
  ensure_window usb-kiss "$(printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/extras/usb-kiss.sh")")"
fi
# Field alerts (extras/alerts.sh) when POCKET_ALERTS=1 turns them on.
if [ "$(env_get POCKET_ALERTS)" = 1 ] && termux_api_ready; then
  ensure_window alerts "$(printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/extras/alerts.sh")")"
fi
# The battery saver (extras/battery.sh) likewise, unless POCKET_BATTERY_LOW=0 turns it off.
if [ "$(env_get POCKET_BATTERY_LOW)" != 0 ] && termux_api_ready; then
  ensure_window battery "$(printf 'APRSCACHING_DIR=%s APRSCACHING_DATA=%s bash %s' \
    "$(q "$DIR")" "$(q "$DATA")" "$(q "$HERE/extras/battery.sh")")"
fi
ensure_window logs "$(logs_cmd)"
ensure_window shell
[ "$already" -eq 0 ] || info "the session was running; missing windows added"

if [ "$ATTACH" -eq 0 ]; then
  healthy=0
  for _ in $(seq 1 "${APRSCACHING_START_WAIT:-120}"); do
    if health_ok "$BASE" 2; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    info "gateway healthy on $BASE; a browser on this phone opens http://localhost:$(gateway_port)"
  else
    warn "the gateway does not answer on $BASE yet; see $LOG_DIR/gateway.log or run status.sh"
  fi
  info "attach with:  tmux attach -t $SESSION      status:  bash $HERE/status.sh"
  exit 0
fi

if [ -n "${TMUX:-}" ]; then
  exec tmux switch-client -t "=$SESSION"
fi
exec tmux attach-session -t "=$SESSION"
