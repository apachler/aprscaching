#!/usr/bin/env bash
# Set up a MeshCom node that sends everything it handles to the ingest over ExtUDP (UDP 1799). The node
# joins a network the phone is on: the phone's own hotspot, or the Wi-Fi network (a router) the phone has
# joined. This script
#
#   1. finds that network on the phone: the one that is up, or, with both up, the one the operator picks
#      (read at run time; the hotspot's subnet differs between phones);
#   2. on the hotspot, suggests a fixed address for the node high in its subnet, away from the phone's own
#      address and from the devices the phone currently sees; on a router, takes the address the router
#      reserves for the node (its DHCP server stays in charge of the network);
#   3. prints the commands to enter on the node (serial console, the MeshCom app or its web page); it
#      never sends anything to the node itself;
#   4. writes MESHCOM_NODE=<node address>=<node call> to ~/.aprscaching/.env and restarts the ingest.
#
#   bash ~/aprscaching/deploy/pocket/meshcom-setup.sh
#   bash ~/aprscaching/deploy/pocket/meshcom-setup.sh --call OE8APR-12 --yes
#   bash ~/aprscaching/deploy/pocket/meshcom-setup.sh --wifi --node-ip 192.168.1.60
#
# The node needs MeshCom firmware 4.35t built on or after 2026-09-25, or newer (older builds can crash
# with ExtUDP on); the fixed-address commands exist since 4.34i. Should the network's subnet change (the
# hotspot's, after a reboot on some phones), run this again and enter the new commands. Telling the
# hotspot from a joined Wi-Fi needs the Termux:API app and package; without them, the script asks.
#
# Options:
#   --hotspot            use the phone's hotspot without asking when a joined Wi-Fi is up too
#   --wifi               use the Wi-Fi network the phone has joined without asking when the hotspot is up too
#   --call CALL-SSID     the node's callsign, e.g. OE8APR-12   (asked when missing on a terminal)
#   --node-ip ADDR       the node's address: on the hotspot instead of the suggested one; on a router the
#                        address the router reserves for the node
#   --ip ADDR[/PREFIX]   the phone's address on that network, when it is not found or several could be it
#   --ssid NAME          the network's name, printed into the node commands
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
MODE=""
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
    --hotspot) MODE=hotspot ;;
    --wifi) MODE=wifi ;;
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

# ---- 1. the network ------------------------------------------------------------------------------------
step "The network the node joins"
wifi_detect
# The joined Wi-Fi with its prefix (Termux:API names its address), and the hotspot's addresses.
wifi_cidr=""
if [ -n "$WIFI_IP" ]; then
  wifi_cidr="$(list_ipv4 | awk -v ip="$WIFI_IP" '{a = $2; sub(/\/.*/, "", a); if (a == ip) {print $2; exit}}')"
  wifi_cidr="${wifi_cidr:-$WIFI_IP/24}"
fi
mapfile -t spots < <(hotspot_candidates | awk '{print $2}')
sure=0
if [ "${#spots[@]}" -eq 1 ] && hotspot_candidates | awk '$3 == "hotspot"' | grep -q .; then sure=1; fi
if [ -n "$HOTSPOT" ]; then
  # An address named with --ip: the joined Wi-Fi's own address means the router, anything else the hotspot.
  if [ -z "$MODE" ]; then
    if [ "${HOTSPOT%%/*}" = "$WIFI_IP" ]; then MODE=wifi; else MODE=hotspot; fi
  fi
elif [ "$MODE" = wifi ]; then
  [ -n "$wifi_cidr" ] || die "the phone has not joined a Wi-Fi network (or Termux:API is missing)." \
    "Join the router's Wi-Fi, or name the phone's address on it with --ip ADDR/PREFIX."
  HOTSPOT="$wifi_cidr"
elif [ -z "$MODE" ] && [ "$sure" -eq 1 ] && [ -n "$wifi_cidr" ]; then
  # Both are up: the operator decides which network the node joins.
  wifi_name="the Wi-Fi network${WIFI_SSID:+ $WIFI_SSID}"
  [ "$TTY" -eq 1 ] || die "both the hotspot (${spots[0]}) and $wifi_name ($wifi_cidr) are up." \
    "Pass --hotspot or --wifi to choose the one the node joins."
  info "both are up: the hotspot (${spots[0]}) and $wifi_name ($wifi_cidr)"
  answer="$(ask "which one does the node join: the hotspot (h) or the Wi-Fi network (w)?" h)"
  case "$answer" in
    w | W) MODE=wifi HOTSPOT="$wifi_cidr" ;;
    *) MODE=hotspot HOTSPOT="${spots[0]}" ;;
  esac
elif [ "${#spots[@]}" -eq 1 ] && { [ "$MODE" = hotspot ] || [ "$sure" -eq 1 ]; }; then
  MODE=hotspot
  HOTSPOT="${spots[0]}"
  [ -n "$wifi_cidr" ] || info "the hotspot is up, no Wi-Fi network joined; using the hotspot"
elif [ "${#spots[@]}" -gt 1 ]; then
  [ "$TTY" -eq 1 ] || die "several addresses could be the hotspot: ${spots[*]}" "Name the hotspot with --ip ADDR/PREFIX."
  info "several addresses could be the hotspot (a joined Wi-Fi looks the same without Termux:API):"
  for c in "${spots[@]}"; do info "  $c"; done
  HOTSPOT="$(ask "which one is the hotspot" "${spots[0]}")"
  MODE=hotspot
elif [ "${#spots[@]}" -eq 1 ]; then
  # Without Termux:API a wlan address may be either; only the operator knows which.
  [ "$TTY" -eq 1 ] || die "cannot tell whether ${spots[0]} is the hotspot or a joined Wi-Fi (Termux:API is missing)." \
    "Pass --hotspot or --wifi."
  answer="$(ask "is ${spots[0]} the phone's hotspot (h) or a Wi-Fi network it joined (w)?" h)"
  case "$answer" in w | W) MODE=wifi ;; *) MODE=hotspot ;; esac
  HOTSPOT="${spots[0]}"
elif [ "$MODE" != hotspot ] && [ -n "$wifi_cidr" ]; then
  MODE=wifi
  HOTSPOT="$wifi_cidr"
  info "the hotspot is off; using the Wi-Fi network${WIFI_SSID:+ $WIFI_SSID} the phone has joined"
else
  [ "$TTY" -eq 1 ] || die "neither a hotspot nor a joined Wi-Fi network found." \
    "Turn the hotspot on or join the router's Wi-Fi, or name the address with --ip ADDR/PREFIX."
  info "neither a hotspot nor a joined Wi-Fi network found (status.sh lists the phone's addresses)"
  HOTSPOT="$(ask "the phone's address on the node's network, e.g. 192.168.43.1/24")"
  answer="$(ask "is that the phone's hotspot (h) or a Wi-Fi network it joined (w)?" h)"
  case "$answer" in w | W) MODE=wifi ;; *) MODE=hotspot ;; esac
fi
[ -n "$MODE" ] || MODE=hotspot
if [ "$MODE" = wifi ]; then NETNAME="the Wi-Fi network"; else NETNAME="the hotspot"; fi
if [ -z "$SSID" ] && [ "$MODE" = wifi ]; then SSID="$WIFI_SSID"; fi
PHONE_IP="${HOTSPOT%%/*}"
PREFIX="${HOTSPOT#*/}"
[ "$PREFIX" != "$HOTSPOT" ] || PREFIX=24
if ! valid_ipv4 "$PHONE_IP" || ! is_private_ipv4 "$PHONE_IP"; then
  die "'$PHONE_IP' is not a private IPv4 address (10/8, 172.16/12, 192.168/16)."
fi
case "$PREFIX" in '' | *[!0-9]*) die "'/$PREFIX' is not a prefix length." ;; esac
[ "$PREFIX" -ge 16 ] && [ "$PREFIX" -le 30 ] || die "a /$PREFIX subnet is unusual; name it with --ip ADDR/PREFIX (16–30)."
MASK="$(prefix_mask "$PREFIX")"
maskn=$(((0xffffffff << (32 - PREFIX)) & 0xffffffff))
NET=$(($(ip_to_int "$PHONE_IP") & maskn))
BCAST=$((NET | (~maskn & 0xffffffff)))
info "$NETNAME${SSID:+ $SSID}: phone $PHONE_IP, subnet $(int_to_ip "$NET")/$PREFIX (mask $MASK)"

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
if [ -z "$NODE_IP" ] && [ "$MODE" = wifi ]; then
  # The router's DHCP server owns this network: the node takes the address the router reserves for it.
  [ "$TTY" -eq 1 ] || die "on a router, the node's address is the one the router reserves for it." \
    "Reserve one in the router's DHCP settings and pass it with --node-ip ADDR."
  info "reserve an address for the node in the router's DHCP settings (by the node's MAC address)"
  NODE_IP="$(ask "the node's reserved address")"
fi
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
in_subnet "$NODE_IP" || die "$NODE_IP is outside the subnet of $NETNAME, $(int_to_ip "$NET")/$PREFIX."
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
if [ "$MODE" = hotspot ]; then
  cat <<EOF

    --setssid ${SSID:-<the hotspot name>}
    --setpwd <the hotspot password>
    --setownip $NODE_IP
    --setowngw $PHONE_IP
    --setownms $MASK
    --extudpip $PHONE_IP
    --extudp on

EOF
  info "The node joins the hotspot with that fixed address and sends to UDP 1799 on the phone."
else
  cat <<EOF

    --setssid ${SSID:-<the Wi-Fi name>}
    --setpwd <the Wi-Fi password>
    --extudpip $PHONE_IP
    --extudp on

EOF
  info "The node joins the router's Wi-Fi and takes its address from the router. In the router's DHCP"
  info "settings, reserve $NODE_IP for the node and $PHONE_IP for this phone: the node sends to the"
  info "phone's address, and the ingest accepts only the node's. Android keeps one random MAC address per"
  info "network; if the phone's address still changes, set that network to use the device MAC."
  info "A node given a fixed hotspot address earlier keeps it: give it one here instead (--setownip"
  info "$NODE_IP, --setowngw <the router's address>, --setownms $MASK)."
  info "Everyone on this network can reach the station, and could send datagrams in the node's name:"
  info "use a router you control."
fi
info "Power-cycle the node if it does not appear within a minute; --info on the node shows its Wi-Fi."
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
  # The listener binds one address, on the first node's subnet: a node elsewhere is not heard.
  if valid_ipv4 "$ip" && ! in_subnet "$ip"; then
    warn "$e stays in MESHCOM_NODE but is outside the subnet of $NETNAME; the ingest hears nodes on one subnet only."
  fi
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
