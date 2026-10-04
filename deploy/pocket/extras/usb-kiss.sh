#!/usr/bin/env bash
# A USB KISS TNC on the phone's USB-C port (OTG), for the ingest: the phone then logs every station the TNC
# hears, off-grid. extras/usb_kiss_bridge.py drives the TNC through the file descriptor termux-usb hands
# over and serves KISS over TCP on 127.0.0.1:8001, where the ingest connects (KISS_TNC_HOST/KISS_TNC_PORT).
# What the TNC hears is a local TNC's hearing like any other: it names RF_SITE_CALL when set, and counts
# toward Tier A only once that call is trusted under Instance admin → Trusted receiving stations (or listed
# in FIRST_PARTY_SITES).
#
#   bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --list
#   bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --setup [--device /dev/bus/usb/001/002] [--baud 9600]
#   bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh        # run the bridge (start.sh does, in window usb-kiss)
#
# --setup writes USB_KISS_DEVICE, USB_KISS_BAUD, KISS_TNC_HOST=127.0.0.1 and KISS_TNC_PORT to the .env and
# restarts the station. Android asks once for permission to use the device.
#
# Receive-only unless all three hold: USB_KISS_TX=1 in the .env, the operator's callsign is
# control-verified on this station, and the bridge is started with transmit (it then passes KISS data
# frames through a watchdog: 6 a minute, 3 in a burst). You are the control operator of an automatic station
# then; read docs/shack/on-air.md first. The station notification shows "USB TNC: TX ON".
#
# Only CDC-ACM TNCs work (no driver needed); FTDI, CP210x, CH340 and PL2303 chips are refused by name.
# Needs the Termux:API app, `pkg install termux-api python libusb`.
#
# Options:
#   --list               list the USB devices Android sees
#   --setup              choose the device and write the .env
#   --device PATH        the device (/dev/bus/usb/BBB/DDD); default the only one attached
#   --baud N             the TNC's serial speed (default 9600)
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

MODE=run
DEVICE=""
BAUD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list ;;
    --setup) MODE=setup ;;
    --device) DEVICE="${2:-}"; shift ;;
    --baud) BAUD="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

BRIDGE="$HERE/extras/usb_kiss_bridge.py"
PORT="$(env_get KISS_TNC_PORT)"
PORT="${PORT:-8001}"
TX_STATE="$RUN_DIR/usb-kiss.tx"

have termux-usb || die "termux-usb is missing." "Install the Termux:API app, then:  pkg install termux-api"
have python3 || die "python3 is missing." "Install it with:  pkg install python"

# The attached devices, one path per line (termux-usb -l prints a JSON array).
devices() { termux_api termux-usb -l | tr -d '[]" ' | tr ',' '\n' | grep -E '^/dev/bus/usb/' || true; }

pick_device() {
  [ -n "$DEVICE" ] && return
  DEVICE="$(env_get USB_KISS_DEVICE)"
  local list n
  list="$(devices)"
  n="$(printf '%s' "$list" | grep -c . || true)"
  if [ -n "$DEVICE" ] && grep -qxF "$DEVICE" <<<"$list"; then return; fi
  case "$n" in
    0) DEVICE="" ;;
    1) DEVICE="$list" ;;
    *) die "several USB devices are attached:" "$list" "Name one with --device PATH." ;;
  esac
}

case "$MODE" in
  list)
    list="$(devices)"
    if [ -n "$list" ]; then printf '%s\n' "$list"; else info "no USB device attached (a USB-C OTG adapter may be needed)"; fi
    exit 0
    ;;
  setup)
    pick_device
    [ -n "$DEVICE" ] || die "no USB device attached." "Attach the TNC (through an OTG adapter), then run this again."
    BAUD="${BAUD:-$(env_get USB_KISS_BAUD)}"
    BAUD="${BAUD:-9600}"
    case "$BAUD" in '' | *[!0-9]*) die "--baud takes a number (got '$BAUD')." ;; esac
    step "USB KISS TNC at $DEVICE, $BAUD baud"
    info "Android asks once for permission to use the device; allow it."
    termux_api termux-usb -r "$DEVICE" >/dev/null || true
    env_set USB_KISS_DEVICE "$DEVICE"
    env_set USB_KISS_BAUD "$BAUD"
    env_set KISS_TNC_HOST 127.0.0.1
    env_set KISS_TNC_PORT "$PORT"
    info "wrote USB_KISS_DEVICE, USB_KISS_BAUD, KISS_TNC_HOST=127.0.0.1 and KISS_TNC_PORT=$PORT"
    [ -n "$(env_get RF_SITE_CALL)" ] || info "set RF_SITE_CALL to this station's call to name it as the receiving site"
    if session_exists; then
      APRSCACHING_DIR="$DIR" APRSCACHING_DATA="$DATA" bash "$HERE/start.sh" --no-attach >/dev/null
      restart_proc ingest || true
      info "the bridge runs in the tmux window usb-kiss; the ingest connects to it"
    fi
    exit 0
    ;;
esac

# ---- run: keep the bridge up while the device is attached --------------------------------------------
BAUD="$(env_get USB_KISS_BAUD)"
BAUD="${BAUD:-9600}"
tx_allowed() {
  [ "$(env_get USB_KISS_TX)" = 1 ] || return 1
  local verified
  verified="$(station_status "" | json_field operatorVerified)"
  if [ "$verified" != true ]; then
    warn "USB_KISS_TX=1, but the operator's callsign is not control-verified: receive-only"
    return 1
  fi
}
trap 'rm -f "$TX_STATE"' EXIT
delay=5
while :; do
  DEVICE=""
  pick_device
  if [ -z "$DEVICE" ]; then
    info "waiting for the USB TNC ($(env_get USB_KISS_DEVICE); attach it, or run --setup)"
    sleep 15
    continue
  fi
  tx=()
  rm -f "$TX_STATE"
  if tx_allowed; then
    tx=(--tx)
    date +%s >"$TX_STATE"
  fi
  started=$(date +%s)
  # termux-usb -e appends the device's file descriptor to the command, after --fd.
  termux_api termux-usb -r "$DEVICE" >/dev/null || true
  status=0
  termux-usb -e "python3 $(printf '%q' "$BRIDGE") --port $PORT --baud $BAUD ${tx[*]} --fd" "$DEVICE" || status=$?
  rm -f "$TX_STATE"
  if [ $(($(date +%s) - started)) -ge 60 ]; then delay=5; fi
  info "the bridge stopped (status $status); again in ${delay}s"
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -le 60 ] || delay=60
done
