#!/usr/bin/env bash
# Set up a MeshCom node on the phone's hotspot: the node joins the hotspot with a fixed address and sends
# everything it handles to the ingest over ExtUDP (UDP 1799). This script
#
#   1. finds the hotspot's address and subnet on the phone (read at run time; it differs between phones);
#   2. suggests a fixed address for the node inside that subnet, high in the range, away from the phone's
#      own address and from the devices the phone currently sees;
#   3. prints the commands to enter on the node (serial console, the MeshCom app or its web page); it
#      never sends anything to the node itself;
#   4. writes MESHCOM_NODE=<node address>=<node call> to ~/.aprscaching/.env and restarts the ingest.
#
#   bash ~/aprscaching/deploy/pocket/meshcom-setup.sh
#   bash ~/aprscaching/deploy/pocket/meshcom-setup.sh --call OE8APR-12 --yes
#
# The hotspot must be on. The node needs MeshCom firmware 4.35t built on or after 2026-09-25, or newer
# (older builds can crash with ExtUDP on); the fixed-address commands exist since 4.34i. Should the
# hotspot's subnet change (after a reboot on some phones), run this again and enter the new commands.
#
# Options:
#   --call CALL-SSID     the node's callsign, e.g. OE8APR-12   (asked when missing on a terminal)
#   --node-ip ADDR       the node's fixed address instead of the suggested one
#   --ip ADDR[/PREFIX]   the phone's hotspot address, when it is not found or several could be it
#   --ssid NAME          the hotspot's name, printed into the node commands
#   --yes                write the .env and restart the ingest without asking
#   --no-write           only print the commands
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

NODE_CALL=""
NODE_IP=""
HOTSPOT=""
SSID=""
YES=0
WRITE=1
# --dir is accepted like in the other scripts, though this one does not use the checkout.
# shellcheck disable=SC2034
while [ $# -gt 0 ]; do
  case "$1" in
    --call) NODE_CALL="${2:-}"; shift ;;
    --node-ip) NODE_IP="${2:-}"; shift ;;
    --ip) HOTSPOT="${2:-}"; shift ;;
    --ssid) SSID="${2:-}"; shift ;;
    --yes) YES=1 ;;
    --no-write) WRITE=0 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."

TTY=0
if [ -t 0 ] && [ -t 1 ]; then TTY=1; fi
ask() {
  local prompt=$1 default=${2:-} answer
  [ "$TTY" -eq 1 ] || { printf '%s' "$default"; return; }
  read -r -p "    $prompt${default:+ [$default]}: " answer </dev/tty
  printf '%s' "${answer:-$default}"
}
valid_ipv4() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  for x in "$a" "$b" "$c" "$d"; do
    case "$x" in '' | *[!0-9]*) return 1 ;; esac
    [ "$x" -le 255 ] || return 1
  done
  [ "$(printf '%s' "$1" | tr -cd . | wc -c)" -eq 3 ]
}

# ---- 1. the hotspot ------------------------------------------------------------------------------------
step "The phone's hotspot"
wifi_detect
if [ -z "$HOTSPOT" ]; then
  mapfile -t cands < <(hotspot_candidates | awk '{print $2}')
  case "${#cands[@]}" in
    1) HOTSPOT="${cands[0]}" ;;
    0)
      [ "$TTY" -eq 1 ] || die "no hotspot address found." "Turn the hotspot on, or name the address with --ip ADDR/PREFIX."
      info "no hotspot address found; is the hotspot on? (status.sh lists the phone's addresses)"
      HOTSPOT="$(ask "the phone's hotspot address, e.g. 192.168.43.1/24")"
      ;;
    *)
      [ "$TTY" -eq 1 ] || die "several addresses could be the hotspot: ${cands[*]}" "Name the hotspot with --ip ADDR/PREFIX."
      info "several addresses could be the hotspot (a joined Wi-Fi looks the same without Termux:API):"
      for c in "${cands[@]}"; do info "  $c"; done
      HOTSPOT="$(ask "which one is the hotspot" "${cands[0]}")"
      ;;
  esac
fi
PHONE_IP="${HOTSPOT%%/*}"
PREFIX="${HOTSPOT#*/}"
[ "$PREFIX" != "$HOTSPOT" ] || PREFIX=24
if ! valid_ipv4 "$PHONE_IP" || ! is_private_ipv4 "$PHONE_IP"; then
  die "'$PHONE_IP' is not a private IPv4 address (10/8, 172.16/12, 192.168/16)."
fi
case "$PREFIX" in '' | *[!0-9]*) die "'/$PREFIX' is not a prefix length." ;; esac
[ "$PREFIX" -ge 16 ] && [ "$PREFIX" -le 30 ] || die "a /$PREFIX hotspot subnet is unusual; name it with --ip ADDR/PREFIX (16–30)."
MASK="$(prefix_mask "$PREFIX")"
maskn=$(((0xffffffff << (32 - PREFIX)) & 0xffffffff))
NET=$(($(ip_to_int "$PHONE_IP") & maskn))
BCAST=$((NET | (~maskn & 0xffffffff)))
info "phone $PHONE_IP, subnet $(int_to_ip "$NET")/$PREFIX (mask $MASK)"

in_subnet() { [ $(($(ip_to_int "$1") & maskn)) -eq "$NET" ]; }

# ---- 2. the node's address and call --------------------------------------------------------------------
step "The node"
existing="$(env_get MESHCOM_NODE)"
# A node already configured on this subnet keeps its address and call unless told otherwise.
old_ip=""
old_call=""
IFS=, read -r -a entries <<<"$existing"
for e in "${entries[@]}"; do
  ip="${e%%=*}"
  if valid_ipv4 "$ip" && in_subnet "$ip"; then
    old_ip="$ip"
    [ "$e" = "$ip" ] || old_call="${e#*=}"
    break
  fi
done

if [ -z "$NODE_IP" ] && [ -n "$old_ip" ]; then NODE_IP="$old_ip"; fi
if [ -z "$NODE_IP" ]; then
  # The addresses the phone has seen on the hotspot recently (its neighbour table), to step around.
  seen="$( (ip -4 neigh show 2>/dev/null || true) | awk '{print $1}')"
  n=$((BCAST - 1))
  lowest=$((NET + (BCAST - NET) / 2))
  while [ "$n" -gt "$lowest" ]; do
    cand="$(int_to_ip "$n")"
    if [ "$cand" != "$PHONE_IP" ] && ! grep -qxF "$cand" <<<"$seen"; then break; fi
    n=$((n - 1))
  done
  NODE_IP="$(ask "fixed address for the node" "$(int_to_ip "$n")")"
fi
valid_ipv4 "$NODE_IP" || die "'$NODE_IP' is not an IPv4 address."
in_subnet "$NODE_IP" || die "$NODE_IP is outside the hotspot subnet $(int_to_ip "$NET")/$PREFIX."
n=$(ip_to_int "$NODE_IP")
[ "$n" -ne "$NET" ] && [ "$n" -ne "$BCAST" ] || die "$NODE_IP is the subnet's network or broadcast address."
[ "$NODE_IP" != "$PHONE_IP" ] || die "$NODE_IP is the phone's own address."

if [ -z "$NODE_CALL" ]; then
  base="$(env_get ADMIN_CALLSIGNS)"
  base="${base%%,*}"
  NODE_CALL="$(ask "the node's callsign with SSID" "${old_call:-${base:+$base-12}}")"
fi
NODE_CALL="$(printf '%s' "$NODE_CALL" | tr '[:lower:]' '[:upper:]')"
printf '%s' "$NODE_CALL" | grep -Eq '^[A-Z0-9]{3,7}(-[0-9]{1,2})?$' ||
  die "'$NODE_CALL' is not a callsign like OE8APR-12." "Pass it with --call CALL-SSID."
info "node $NODE_CALL at $NODE_IP"

# ---- 3. the node's commands ----------------------------------------------------------------------------
step "Enter these on the node (serial console, the MeshCom app or its web page)"
ssid_arg="${SSID:-<the hotspot name>}"
cat <<EOF

    --setssid $ssid_arg
    --setpwd <the hotspot password>
    --setownip $NODE_IP
    --setowngw $PHONE_IP
    --setownms $MASK
    --extudpip $PHONE_IP
    --extudp on

EOF
info "The node joins the hotspot as a client and sends to UDP 1799 on the phone. Power-cycle it if it"
info "does not appear within a minute; --info on the node shows its Wi-Fi state."
info "ExtUDP has no authentication: the ingest accepts datagrams only from $NODE_IP."

# ---- 4. the .env and the ingest ------------------------------------------------------------------------
if [ "$WRITE" -eq 0 ]; then
  info "--no-write: $ENV_FILE is unchanged. Its line would be:  MESHCOM_NODE=$NODE_IP=$NODE_CALL"
  exit 0
fi
# Keep the other nodes; replace the one on this subnet or with this call.
new="$NODE_IP=$NODE_CALL"
for e in "${entries[@]}"; do
  [ -n "$e" ] || continue
  ip="${e%%=*}"
  call=""
  [ "$e" = "$ip" ] || call="${e#*=}"
  if [ "$ip" = "$old_ip" ] || [ "$ip" = "$NODE_IP" ] || [ "$call" = "$NODE_CALL" ]; then continue; fi
  new="$new,$e"
done
step "Writing $ENV_FILE"
if [ "$YES" -eq 0 ] && [ "$TTY" -eq 1 ]; then
  answer="$(ask "write MESHCOM_NODE=$new and restart the ingest? (y/n)" y)"
  case "$answer" in y | Y | yes) ;; *) info "unchanged"; exit 0 ;; esac
elif [ "$YES" -eq 0 ]; then
  die "not on a terminal: pass --yes to write the .env, or --no-write to print only."
fi
env_set MESHCOM_NODE "$new"
info "MESHCOM_NODE=$new"
if session_exists && restart_proc ingest; then
  info "the ingest log shows:  [meshcom] listening udp/1799 on $PHONE_IP for $NODE_IP ($NODE_CALL)"
else
  info "the ingest is not running; start the station with:  bash $HERE/start.sh"
fi
info "status.sh shows the MeshCom line; positions and messages from the node appear on the map."
info "Direct hearings by your own node count toward Tier A only once its call is in FIRST_PARTY_SITES"
info "(docs/operate/meshcom.md); that is your decision, this script does not set it."
