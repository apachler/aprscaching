#!/usr/bin/env bash
# Mint a one-time sign-in link for a callsign on this phone's gateway: the way in when a passkey does
# not work (a browser without passkey support on localhost, no email provider off-grid). It loads
# OPERATOR_SECRET and PORT from ~/.aprscaching/.env and runs tools/admin/signin-link.mjs against
# http://127.0.0.1:<PORT>. The link is single-use and expires in 15 minutes; open it in the browser on
# this phone, or hand it to its owner in person, never over a channel others read.
#
#   bash ~/aprscaching/deploy/pocket/signin-link.sh OE8APR
#   bash ~/aprscaching/deploy/pocket/signin-link.sh --hotspot OE8VIS
#
# --hotspot mints a link for a visitor on the phone's hotspot, under the visitor's own call: it names the
# station's https origin at the hotspot address and prints a QR code for the visitor's phone to scan. It
# needs https on (tls.sh). The visitor's account starts unverified and logs finds under that call only.
#
# Options:
#   --hotspot            the link names https://<hotspot address>:<HTTPS_PORT>, with a QR code
#   --ip ADDR            with --hotspot: the address to name, when the phone has several private ones
#   --qr                 also print the link as a QR code
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

CALL=""
HOTSPOT=0
IP=""
QR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hotspot) HOTSPOT=1 ;;
    --ip) IP="${2:-}"; HOTSPOT=1; shift ;;
    --qr) QR=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
    *) CALL="$1" ;;
  esac
  shift
done
pocket_paths
[ -n "$CALL" ] || { pocket_usage "$0" >&2; exit 2; }

env_load
[ -n "${OPERATOR_SECRET:-}" ] || die "OPERATOR_SECRET is empty in $ENV_FILE." \
  "Set one (node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\") and restart the gateway."
ARGS=()
if [ "$HOTSPOT" -eq 1 ]; then
  HTTPS="$(tls_port)"
  [ -n "$HTTPS" ] || die "https is off, and a visitor's browser needs it for sign-in and location." \
    "Turn it on with:  bash $HERE/tls.sh"
  if [ -z "$IP" ]; then
    wifi_detect
    # The hotspot's address; without Termux:API a joined Wi-Fi looks the same, so more than one is asked.
    mapfile -t cands < <(hotspot_candidates | awk '{sub(/\/.*/, "", $2); print $2}')
    case "${#cands[@]}" in
      0) die "no hotspot address found." "Turn the hotspot on, or name the address with --ip ADDR." ;;
      1) IP="${cands[0]}" ;;
      *) die "several addresses could be the hotspot: ${cands[*]}" "Name the one visitors reach with --ip ADDR." ;;
    esac
  fi
  is_private_ipv4 "$IP" || die "--ip $IP is not a private address (10/8, 172.16/12, 192.168/16)."
  ARGS=(--link-origin "https://$IP:$HTTPS" --qr)
  info "a link for $CALL at https://$IP:$HTTPS; the visitor scans the QR code on the hotspot" >&2
elif [ "$QR" -eq 1 ]; then
  ARGS=(--qr)
fi
BASE="http://127.0.0.1:${PORT:-8787}" exec node "$DIR/tools/admin/signin-link.mjs" "${ARGS[@]}" "$CALL"
