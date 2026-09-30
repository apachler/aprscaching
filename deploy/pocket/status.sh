#!/usr/bin/env bash
# Show the state of the Pocket station: the tmux session, the gateway and the ingest (running, uptime,
# restarts), the gateway's /health, the networks it listens on with the URL other devices use on each
# (the hotspot included, and its https URL when tls.sh turned https on), storage, and the battery.
# Changes nothing.
#
#   bash ~/aprscaching/deploy/pocket/status.sh
#
# The gateway listens on every interface of the phone. The addresses are read at run time (ip, else
# ifconfig), since the hotspot's subnet differs between phones and Android versions. The Wi-Fi and
# battery lines need the Termux:API app and package (pkg install termux-api); without them they are
# skipped.
#
# Options:
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

# --dir is accepted like in the other scripts, though this one does not use the checkout.
# shellcheck disable=SC2034
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

[ -f "$ENV_FILE" ] || warn "$ENV_FILE is missing: run deploy/pocket/install.sh first."
PORT="$(gateway_port)"
BASE="$(gateway_base)"
HTTPS="$(tls_port)"
NOW="$(date +%s)"

human_bytes() { awk -v b="${1:-0}" 'BEGIN{split("B KiB MiB GiB TiB",u," ");i=1;while(b>=1024&&i<5){b/=1024;i++};printf (i==1?"%d %s":"%.1f %s"),b,u[i]}'; }
file_bytes() { if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else echo 0; fi; }

# ---- session and processes ---------------------------------------------------------------------------
step "Station"
if session_exists; then
  info "tmux session $SESSION: running (windows: $(tmux list-windows -t "=$SESSION" -F '#{window_name}' | paste -sd ' ' -))"
else
  info "tmux session $SESSION: not running (start it with: bash $HERE/start.sh)"
fi
for name in "${POCKET_PROCS[@]}"; do
  sup="$(state_get "$name" supervisor)"
  pid="$(state_get "$name" pid)"
  restarts="$(state_get "$name" restarts)"
  if ! [ -f "$(state_file "$name")" ]; then
    line="not started"
  elif ! is_ours "$sup" supervise.sh; then
    line="stopped"
  elif is_ours "$pid" "$(proc_entry "$name")"; then
    started="$(state_get "$name" started)"
    line="running, pid $pid, up $(human_duration $((NOW - ${started:-$NOW}))), restarts ${restarts:-0}"
  else
    next="$(state_get "$name" next_start)"
    last="$(state_get "$name" last_exit)"
    if [ -n "$next" ]; then
      wait_s=$((next - NOW))
      [ "$wait_s" -ge 0 ] || wait_s=0
      line="restarting in ${wait_s}s (last exit status ${last:-?}), restarts ${restarts:-0}"
    else
      line="starting (restarts ${restarts:-0})"
    fi
  fi
  printf '    %-8s %s\n' "$name" "$line"
done

# ---- gateway health ----------------------------------------------------------------------------------
step "Gateway"
if body="$(curl -fsS --max-time 3 "$BASE/health" 2>/dev/null)"; then
  info "$BASE/health: OK $(printf '%s' "$body" | tr -d '\n' | cut -c1-120)"
else
  info "$BASE/health: no answer"
fi

# ---- networks ----------------------------------------------------------------------------------------
wifi_detect
step "Networks (the gateway listens on every interface, port $PORT)"
row() { info "$(printf '%-12s %-19s %-30s %s' "$@")"; }
row "this phone" "127.0.0.1" "http://localhost:$PORT" "a browser on the phone"
wlan_seen=0
found=0
hotspot_ip=""
uncovered=""
while read -r name cidr; do
  [ -n "${name:-}" ] || continue
  ip="${cidr%%/*}"
  kind="$(kind_of "$name" "$ip")"
  [ "$kind" != loopback ] || continue
  found=1
  url="http://$ip:$PORT"
  case "$kind" in
    hotspot) note="hotspot: devices on it use this URL"; [ -n "$hotspot_ip" ] || hotspot_ip="$ip" ;;
    wifi-client) note="Wi-Fi client${WIFI_SSID:+ of $WIFI_SSID}" ;;
    wlan) note="Wi-Fi (the hotspot, or a network this phone joined)"; wlan_seen=1 ;;
    usb-tether) note="USB tethering" ;;
    bt-tether) note="Bluetooth tethering" ;;
    mobile) note="mobile data: behind the carrier's NAT, not reachable from outside"; url="-" ;;
    vpn) note="VPN" ;;
    ethernet) note="Ethernet" ;;
    *) note="" ;;
  esac
  if [ "$url" != "-" ]; then
    if health_ok "$url" 2; then note="answers; $note"; else note="no answer; $note"; fi
  fi
  row "$name" "$cidr" "$url" "$note"
  # The https URL: named by the certificate (tls.sh records the addresses it issued for), and checked
  # against the station CA.
  if [ -n "$HTTPS" ] && [ "$url" != "-" ] && is_private_ipv4 "$ip"; then
    if ! grep -qxF "$ip" "$TLS_DIR/station.ips" 2>/dev/null; then
      row "" "" "https://$ip:$HTTPS" "not in the certificate yet"
      uncovered="$uncovered $ip"
    elif curl -fsS -o /dev/null --max-time 2 --cacert "$TLS_CA" "https://$ip:$HTTPS/health" 2>/dev/null; then
      row "" "" "https://$ip:$HTTPS" "answers with the station certificate"
    else
      row "" "" "https://$ip:$HTTPS" "no answer"
    fi
  fi
done < <(list_ipv4)
[ "$found" -eq 1 ] || info "no other interface found (ip and ifconfig gave no IPv4 address)"
if [ -n "$WIFI_IP" ]; then
  warn "this phone is joined to the Wi-Fi network ${WIFI_SSID:+$WIFI_SSID }($WIFI_IP): everyone on that network can" \
    "reach the station on port $PORT. On a network you do not trust, stop the station or leave it."
elif [ "$wlan_seen" -eq 1 ]; then
  info "if a wlan address above belongs to a Wi-Fi network this phone joined, everyone on that network"
  info "can reach port $PORT (install Termux:API to tell a joined network from the hotspot)."
fi

# ---- https for visitors -----------------------------------------------------------------------------
step "https for visitors"
if [ -n "$HTTPS" ]; then
  names="$(paste -sd ' ' "$TLS_DIR/station.ips" 2>/dev/null || true)"
  until="$(openssl x509 -enddate -noout -in "$TLS_LEAF" 2>/dev/null | cut -d= -f2 || true)"
  info "port $HTTPS; the certificate names ${names:-?}; valid until ${until:-?}"
  if [ -n "$uncovered" ]; then
    warn "the certificate does not name:$uncovered yet. The tls window adds a new address within 30 s;" \
      "without it, run: bash $HERE/tls.sh --renew"
  fi
  if session_exists && ! tmux list-windows -t "=$SESSION" -F '#{window_name}' | grep -qxF tls; then
    warn "no tls window: a new hotspot address is not added to the certificate until start.sh runs again"
  fi
  fp="$(openssl x509 -fingerprint -sha256 -noout -in "$TLS_CA" 2>/dev/null | cut -d= -f2 || true)"
  info "visitors install the station CA from http://${hotspot_ip:-<hotspot address>}:$PORT/pocket-ca.crt"
  info "(SHA-256 ${fp:-?}), or accept the browser's warning once"
elif [ -n "$(env_get HTTPS_PORT)" ]; then
  info "port $(env_get HTTPS_PORT), with a certificate tls.sh does not manage ($(env_get TLS_CERT))"
else
  info "off; turn it on with:  bash $HERE/tls.sh"
fi

# ---- ingest inputs -----------------------------------------------------------------------------------
step "Ingest inputs (from $ENV_FILE)"
meshcom="$(env_get MESHCOM_NODE)"
if [ -n "$meshcom" ]; then
  mport="$(env_get MESHCOM_PORT)"
  info "MeshCom ExtUDP: UDP ${mport:-1799}, nodes $meshcom"
  # The listener binds the phone's address on the first node's subnet when the ingest starts, so that
  # network (the hotspot, or the joined Wi-Fi) must be up by then; one that comes up later needs an
  # ingest restart.
  first="${meshcom%%,*}"
  first="${first%%=*}"
  if ! bind_ip="$(local_address_for "$first")"; then
    warn "no address of this phone is on the subnet of $first: the hotspot is off, the phone left that Wi-Fi," \
      "or the subnet changed (then run meshcom-setup.sh again). Once it is back:  bash $HERE/restart.sh ingest"
  else
    last="$(grep -F '[meshcom]' "$LOG_DIR/ingest.log" 2>/dev/null | grep -E 'listening|no local address|disabled' | tail -n 1 || true)"
    case "$last" in
      *listening*) info "listening on $bind_ip (ingest log)" ;;
      *"no local address"* | *disabled*)
        warn "the MeshCom listener did not start (the node's network was down when the ingest started):" \
          "bash $HERE/restart.sh ingest" ;;
    esac
  fi
else
  info "MeshCom ExtUDP: off (MESHCOM_NODE unset)"
fi
aprsis="$(env_get APRSIS_HOST)"
if [ -n "$aprsis" ]; then
  info "APRS-IS: $aprsis:$(env_get APRSIS_PORT) filter $(env_get APRSIS_FILTER) (needs a data connection)"
else
  info "APRS-IS: off (APRSIS_HOST unset)"
fi

# ---- storage -----------------------------------------------------------------------------------------
step "Storage"
DB="$(env_get DB_PATH)"
DB="${DB:-$DATA/aprscaching.db}"
if [ -d "$DATA" ]; then
  df -Pk "$DATA" 2>/dev/null | awk -v d="$DATA" 'NR==2 {printf "    free on %s: %.1f GiB of %.1f GiB (%s used)\n", d, $4/1048576, $2/1048576, $5}' || true
fi
db_bytes=$(($(file_bytes "$DB") + $(file_bytes "$DB-wal") + $(file_bytes "$DB-shm")))
if [ -f "$DB" ]; then
  info "database: $(human_bytes "$db_bytes") ($DB, WAL included)"
else
  info "database: not created yet ($DB)"
fi
MEDIA="$(env_get MEDIA_DIR)"
MEDIA="${MEDIA:-$DATA/media}"
if [ -d "$MEDIA" ]; then info "media: $(du -sh "$MEDIA" 2>/dev/null | cut -f1) ($MEDIA)"; fi
if [ -d "$LOG_DIR" ]; then info "logs: $(du -sh "$LOG_DIR" 2>/dev/null | cut -f1) ($LOG_DIR)"; fi
# The last backup: the scheduled job and the Backup shortcut record it; else the newest archive.
last=""
if [ -f "$RUN_DIR/last-backup" ]; then last="$(cat "$RUN_DIR/last-backup")"; fi
# The archive names carry their UTC time, so the last in name order is the newest.
archives=("$HOME/storage/shared/aprscaching-backups"/aprscaching-pocket-*.tar.gz)
newest="${archives[${#archives[@]} - 1]}"
if [ -f "$newest" ]; then
  mtime="$(stat -c %Y "$newest" 2>/dev/null || echo 0)"
  if [ -z "$last" ] || [ "$mtime" -gt "$last" ]; then last="$mtime"; fi
fi
if [ -n "$last" ]; then
  info "last backup: $(human_duration $((NOW - last))) ago"
else
  info "last backup: none yet (backup.sh, or extras/setup.sh --scheduled-backup)"
fi

# ---- battery -----------------------------------------------------------------------------------------
step "Battery"
if bat="$(termux_api termux-battery-status)" && [ -n "$bat" ]; then
  pct="$(printf '%s' "$bat" | json_field percentage)"
  st="$(printf '%s' "$bat" | json_field status)"
  plug="$(printf '%s' "$bat" | json_field plugged)"
  temp="$(printf '%s' "$bat" | json_field temperature)"
  info "${pct:-?}%, ${st:-?}, ${plug:-?}${temp:+, $temp °C}"
else
  info "unknown (needs the Termux:API app and: pkg install termux-api)"
fi

step "Sign in"
info "a browser on this phone: http://localhost:$PORT"
info "without a passkey, a one-time link:  bash $HERE/signin-link.sh <CALL>"
if [ -n "$HTTPS" ]; then
  info "a visitor on the hotspot:  bash $HERE/signin-link.sh --hotspot <THEIR CALL>   (prints a QR code)"
fi
