# Shared by the Pocket scripts (start, stop, status, update, backup, signin-link, supervise): the paths,
# the .env loader and the per-process state files. Sourced, never run; the including script sets
# `set -euo pipefail` and may override DIR and DATA from its options before calling pocket_paths.
# shellcheck shell=bash
# shellcheck disable=SC2034 # the variables are for the scripts that source this file

DIR="${APRSCACHING_DIR:-$HOME/aprscaching}"
DATA="${APRSCACHING_DATA:-$HOME/.aprscaching}"
SESSION="${APRSCACHING_SESSION:-aprscaching}"

# The two supervised processes: the gateway (servers/node) and the ingest (apps/ingest).
POCKET_PROCS=(gateway ingest)

# Derive every path from DIR and DATA (made absolute: the processes run from their package directories);
# call again after an option changes either.
pocket_paths() {
  case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
  case "$DATA" in /*) ;; *) DATA="$PWD/$DATA" ;; esac
  ENV_FILE="$DATA/.env"
  SAVER_ENV="$DATA/battery-saver.env"
  LOG_DIR="$DATA/logs"
  RUN_DIR="$DATA/run"
  # https for visitors: tls.sh keeps its CA and the station certificate here.
  TLS_DIR="$DATA/tls"
  TLS_CA="$TLS_DIR/ca.crt"
  TLS_LEAF="$TLS_DIR/station.crt"
  TLS_LEAF_KEY="$TLS_DIR/station.key"
}
pocket_paths

# Logging (step, info, warn, die), have and the usage reader are the deploy helpers' (deploy/lib/common.sh).
# shellcheck source=deploy/lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"
pocket_usage() { script_usage "$1"; }

# Read one KEY from the .env without exporting the rest (last assignment wins, quotes stripped).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"
}

# Export every variable of the .env into the current shell, as install.sh prints it.
# The battery saver's overlay (extras/battery.sh writes it while the battery is low): the processes load
# it after the .env, so its few settings win until it is removed.
env_load() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."
  set -a
  # shellcheck disable=SC1090 # the operator's own .env
  . "$ENV_FILE"
  # shellcheck disable=SC1090 # written by extras/battery.sh
  if [ -f "$SAVER_ENV" ]; then . "$SAVER_ENV"; fi
  set +a
}

# Edit the .env in place: the last assignment wins, so a key is removed before it is written once at the
# end. The file stays readable by Termux only.
env_unset() {
  local tmp="$ENV_FILE.tmp.$$" key
  cp -p "$ENV_FILE" "$tmp"
  for key in "$@"; do
    grep -vE "^$key=" "$tmp" >"$tmp.2" || true
    mv -f "$tmp.2" "$tmp"
  done
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}
env_set() {
  env_unset "$1"
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
}

# The operator's scripts and the ingest send their secrets to the gateway over its Unix socket, and the ingest
# reads the USB KISS bridge over the bridge's socket, both in the private run directory: on Android every app
# shares loopback and may bind a free TCP port, so a secret or a KISS stream on 127.0.0.1 can reach another
# app. install.sh runs this on a new .env and on a kept one, so an update needs no step by the operator.
# POCKET_ENV_MOVED is 1 when it changed the .env.
pocket_sockets_env() {
  POCKET_ENV_MOVED=0
  if [ -z "$(env_get GATEWAY_SOCKET)" ]; then
    env_set GATEWAY_SOCKET "$RUN_DIR/gateway.sock"
    POCKET_ENV_MOVED=1
    info "GATEWAY_SOCKET=$RUN_DIR/gateway.sock: the scripts and the ingest reach the gateway there"
  fi
  [ -n "$(env_get USB_KISS_DEVICE)" ] || return 0
  case "$(env_get KISS_TNC_HOST)" in
    127.0.0.1 | localhost | ::1)
      env_set KISS_TNC_HOST "$RUN_DIR/kiss.sock"
      env_unset KISS_TNC_PORT
      POCKET_ENV_MOVED=1
      info "KISS_TNC_HOST=$RUN_DIR/kiss.sock: the ingest reads the USB KISS TNC there"
      ;;
  esac
}

# The windows start.sh runs a helper script in. Each runs the loop of the script it started with, and the lib.sh
# that script read then; respawned, it runs its command again, which loads the scripts on disk and the .env.
POCKET_HELPERS=(tls notify usb-kiss alerts battery)
restart_helpers() {
  session_exists || return 0
  local w
  for w in $(tmux list-windows -t "=$SESSION" -F '#{window_name}' 2>/dev/null); do
    case " ${POCKET_HELPERS[*]} " in
      *" $w "*)
        tmux respawn-window -k -t "=$SESSION:$w"
        info "$w: restarted"
        ;;
    esac
  done
}

# Move a running station onto the sockets pocket_sockets_env wrote, while the update that wrote them runs: the
# gateway and the ingest restart and load the .env; once the gateway answers on its socket, the helper windows
# are respawned, so no loop of an earlier lib.sh goes on sending OPERATOR_SECRET to 127.0.0.1, an earlier
# usb-kiss loop does not start the bridge on a TCP port it no longer has, and the bridge's transmit check
# (station_status) finds the gateway. The update scripts of an earlier release restart only the gateway and the
# ingest, and start.sh leaves a window that exists, so this runs from install.sh, the one script of this release
# every update runs.
pocket_restart_on_sockets() {
  session_exists || return 0
  local sock gw i
  sock="$(env_get GATEWAY_SOCKET)"
  if restart_station; then
    gw="$(state_get gateway supervisor)"
    for i in $(seq 1 "${APRSCACHING_START_WAIT:-120}"); do
      curl -fsS -o /dev/null --max-time 2 --unix-socket "$sock" http://localhost/health 2>/dev/null && break
      if ! is_ours "$gw" supervise.sh; then
        warn "the gateway's supervisor is gone; see $LOG_DIR/gateway.log"
        break
      fi
      [ "$i" -lt "${APRSCACHING_START_WAIT:-120}" ] || warn "the gateway does not answer on $sock yet:" \
        "$(tail -n 5 "$LOG_DIR/gateway.log" 2>/dev/null)"
      sleep 1
    done
  fi
  restart_helpers
}

gateway_port() {
  local p
  p="$(env_get PORT)"
  printf '%s' "${p:-8787}"
}
gateway_base() { printf 'http://127.0.0.1:%s' "$(gateway_port)"; }
health_ok() { curl -fsS -o /dev/null --max-time "${2:-3}" "$1/health" 2>/dev/null; }

# Commands of the Termux:API app block until the app answers; without the app they never return.
# `timeout` bounds them, so a phone without Termux:API only loses that line of output.
termux_api() {
  have "$1" || return 1
  if have timeout; then timeout 8 "$@" 2>/dev/null; else "$@" 2>/dev/null; fi
}

# Whether the Termux:API app answers: the package's commands exist and the app replies in time (a missing
# app, or one never opened since install, leaves them hanging). Checked once per script run.
TERMUX_API_STATE=""
termux_api_ready() {
  if [ -z "$TERMUX_API_STATE" ]; then
    if [ -n "$(termux_api termux-battery-status)" ]; then TERMUX_API_STATE=yes; else TERMUX_API_STATE=no; fi
  fi
  [ "$TERMUX_API_STATE" = yes ]
}
# The one line a script prints when a feature needs Termux:API and it is not there.
termux_api_hint() {
  info "$1: needs the Termux:API app (from the same source as Termux: F-Droid or GitHub) and" \
    "pkg install termux-api"
}

# Whether a soundcard port takes its audio from PulseAudio (SOUNDCARD_AUDIO=pulse, or "audio":"pulse" in
# SOUNDCARD_PORTS).
pulse_wanted() {
  [ "$(env_get SOUNDCARD_AUDIO)" = pulse ] || env_get SOUNDCARD_PORTS | grep -qE '"audio" *: *"pulse"'
}

# Start PulseAudio for the soundcard port when it is wanted and not running: with Android's OpenSL ES capture
# (module-sles-source; Termux's default.pa loads the playback sink itself) and no exit when idle.
pulse_ensure() {
  pulse_wanted || return 0
  if ! have pulseaudio; then
    warn "a soundcard port uses PulseAudio, which is not installed" "Install it with:  pkg install pulseaudio"
    return 0
  fi
  pulseaudio --check 2>/dev/null && return 0
  if pulseaudio --start --load="module-sles-source" --exit-idle-time=-1 2>/dev/null; then
    info "PulseAudio started for the soundcard port"
  else
    warn "PulseAudio did not start" "See why with:  pulseaudio --load=module-sles-source --exit-idle-time=-1 -v"
  fi
}

# The gateway's Unix socket (GATEWAY_SOCKET), where every request carrying OPERATOR_SECRET goes. On Android
# every app with the INTERNET permission shares loopback and may bind the gateway's TCP port while it is free
# (the boot delay, a restart), so a secret sent there goes to whoever holds the port; the socket sits in
# Termux's private data directory, which no other app can open or create files in.
gateway_socket() { env_get GATEWAY_SOCKET; }

# A request to the local gateway with the OPERATOR_SECRET from the .env, through the socket only:
# `operator_curl PATH [curl options…]`. Fails without sending anything when OPERATOR_SECRET or
# GATEWAY_SOCKET is unset (update.sh and install.sh write GATEWAY_SOCKET), never falling back to TCP.
# The header comes from a file descriptor, so the secret never shows in the process list.
operator_curl() {
  local path=$1 secret sock
  shift
  secret="$(env_get OPERATOR_SECRET)"
  sock="$(gateway_socket)"
  [ -n "$secret" ] && [ -n "$sock" ] || return 1
  curl --unix-socket "$sock" -H @<(printf 'x-operator-secret: %s\n' "$secret") "$@" "http://localhost$path"
}

# GET the operator's station summary (/api/admin/station-status) from the local gateway; empty output when
# the gateway does not answer.
station_status() {
  operator_curl "/api/admin/station-status${1:+?since=$1}" -fsS --max-time 5 2>/dev/null
}

# The local gateway's federation sync endpoint (/api/admin/federation/sync): `fed_sync GET` reads the state,
# `fed_sync POST` starts a sync. Empty output when the gateway does not answer.
fed_sync() {
  operator_curl /api/admin/federation/sync -fsS --max-time 5 -X "$1" 2>/dev/null
}
# The sync state as lines for status.sh and sync.sh: the hub push, then any spokes pushing here.
fed_sync_lines() {
  fed_sync GET | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { return; }
      const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 120 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
      const h = j.hub;
      if (h) {
        const wait = Object.entries(h.waiting).filter(([, n]) => n > 0).map(([t, n]) => (n >= h.waitingCap ? n + "+" : n) + " " + t);
        console.log("hub " + h.url + ": " + (h.offlineSince ? "OFFLINE since " + ago(h.offlineSince) + ", retrying" : h.lastOkAt ? "last push " + ago(h.lastOkAt) : "not pushed yet"));
        console.log("waiting to push: " + (wait.length ? wait.join(", ") : "nothing"));
        if (h.lastError && !h.offlineSince) console.log("last error: " + h.lastError);
      }
      for (const sp of j.spokes) console.log("spoke " + sp.instance + ": last submit " + ago(sp.lastSubmitAt) + (sp.stale ? " (STALE)" : ""));
    });'
}

# ---- networks ----------------------------------------------------------------------------------------
# One field of a JSON object on stdin (node is always there; jq may not be).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}})' "$1"
}
# "name addr/prefix" per IPv4 address, from ip or, without it, ifconfig (net-tools and toybox formats).
list_ipv4() {
  if have ip && ip -4 -o addr show >/dev/null 2>&1; then
    ip -4 -o addr show | awk '{sub(/@.*/, "", $2); print $2, $4}'
  elif have ifconfig; then
    ifconfig 2>/dev/null | awk '
      /^[^ \t]/ { name = $1; sub(/:$/, "", name) }
      /inet / {
        for (i = 1; i <= NF; i++) {
          if ($i == "inet") { a = $(i + 1) } else if ($i ~ /^addr:/) { a = substr($i, 6) }
        }
        sub(/^addr:/, "", a)
        if (a != "") print name, a
        a = ""
      }'
  fi
}
# The Wi-Fi network this phone has joined as a client (WIFI_IP, WIFI_SSID), from Termux:API; empty when
# not joined or when Termux:API is missing. Android reports the SSID only to apps holding the location
# permission, so without it Termux:API returns "<unknown ssid>" and WIFI_SSID stays empty.
# WIFI_KNOWN=1 once Termux:API answered, so an unjoined phone's wlan address can only be the hotspot.
WIFI_IP=""
WIFI_SSID=""
WIFI_KNOWN=0
wifi_detect() {
  local wifi
  wifi="$(termux_api termux-wifi-connectioninfo)" || return 0
  [ -n "$wifi" ] || return 0
  WIFI_KNOWN=1
  [ "$(printf '%s' "$wifi" | json_field supplicant_state)" = "COMPLETED" ] || return 0
  WIFI_IP="$(printf '%s' "$wifi" | json_field ip)"
  WIFI_SSID="$(printf '%s' "$wifi" | json_field ssid)"
  [ "$WIFI_SSID" != "<unknown ssid>" ] || WIFI_SSID=""
  [ "$WIFI_IP" != "0.0.0.0" ] || WIFI_IP=""
}
# What an interface name usually is on Android. The Wi-Fi client address, when known, tells the client
# apart from a hotspot that shares the wlan prefix. Call wifi_detect first.
kind_of() {
  local name=$1 ip=$2
  if [ -n "$WIFI_IP" ] && [ "$ip" = "$WIFI_IP" ]; then echo "wifi-client"; return; fi
  case "$name" in
    lo) echo "loopback" ;;
    ap* | swlan* | softap* | wigig*) echo "hotspot" ;;
    wlan*) if [ -n "$WIFI_IP" ] || [ "$WIFI_KNOWN" -eq 1 ]; then echo "hotspot"; else echo "wlan"; fi ;;
    rndis* | usb* | ncm*) echo "usb-tether" ;;
    bt-pan* | bnep*) echo "bt-tether" ;;
    rmnet* | ccmni* | seth* | pdp* | v4-* | clat*) echo "mobile" ;;
    tun* | wg* | ppp* | ipsec*) echo "vpn" ;;
    eth* | en*) echo "ethernet" ;;
    *) echo "other" ;;
  esac
}

# True for an RFC 1918 address (10/8, 172.16/12, 192.168/16): the only addresses the station's https
# certificate names, and the only ones a visitor's sign-in link may name.
is_private_ipv4() {
  local a b
  IFS=. read -r a b _ _ <<<"$1"
  case "$a" in
    10) return 0 ;;
    172) [ "${b:-0}" -ge 16 ] && [ "${b:-0}" -le 31 ] ;;
    192) [ "${b:-}" = 168 ] ;;
    *) return 1 ;;
  esac
}
# "name address" for every private address other devices can reach this phone at: the hotspot, a joined
# Wi-Fi, tethering, Ethernet. Mobile data is left out: its address sits behind the carrier's NAT and
# changes often.
local_ipv4() {
  local name cidr ip
  while read -r name cidr; do
    [ -n "${name:-}" ] || continue
    ip="${cidr%%/*}"
    case "$(kind_of "$name" "$ip")" in loopback | mobile) continue ;; esac
    is_private_ipv4 "$ip" || continue
    printf '%s %s\n' "$name" "$ip"
  done < <(list_ipv4)
}

# "name address/prefix kind" for each interface that may be the phone's hotspot: kind `hotspot` when
# certain (the interface name, or Termux:API; call wifi_detect first), `wlan` when a joined Wi-Fi looks
# the same.
hotspot_candidates() {
  local name cidr kind
  while read -r name cidr; do
    [ -n "${name:-}" ] || continue
    is_private_ipv4 "${cidr%%/*}" || continue
    kind="$(kind_of "$name" "${cidr%%/*}")"
    case "$kind" in hotspot | wlan) printf '%s %s %s\n' "$name" "$cidr" "$kind" ;; esac
  done < <(list_ipv4)
}

# IPv4 arithmetic for the hotspot subnet: dotted quad <-> integer, and the netmask of a prefix length.
ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  printf '%s' $(((a << 24) | (b << 16) | (c << 8) | d))
}
int_to_ip() { printf '%s.%s.%s.%s' $((($1 >> 24) & 255)) $((($1 >> 16) & 255)) $((($1 >> 8) & 255)) $(($1 & 255)); }
prefix_mask() { int_to_ip $(((0xffffffff << (32 - $1)) & 0xffffffff)); }
# The phone's own address on the subnet of $1 (the address a listener for that node binds), or nothing.
local_address_for() {
  local name cidr ip prefix mask
  while read -r name cidr; do
    [ -n "${name:-}" ] || continue
    ip="${cidr%%/*}"
    prefix="${cidr#*/}"
    [ "$prefix" != "$cidr" ] || prefix=32
    mask=$(((0xffffffff << (32 - prefix)) & 0xffffffff))
    if [ $(($(ip_to_int "$ip") & mask)) -eq $(($(ip_to_int "$1") & mask)) ]; then
      printf '%s' "$ip"
      return 0
    fi
  done < <(list_ipv4)
  return 1
}

# ---- 44Net -------------------------------------------------------------------------------------------
# "name address" for this phone's 44Net address, e.g. the WireGuard app's tun0 with 44Net Connect: an address
# in 44Net, ARDC's amateur space, 44.0.0.0/9 or 44.128.0.0/10 (44.192.0.0/10 was sold in 2019 and is not
# 44Net), on any interface. Nothing when there is none. The range says nothing about who reaches the address:
# that depends on how its subnet is routed, and a HAMNET address is a 44Net address too.
net44_address() {
  local name cidr ip b
  while read -r name cidr; do
    [ -n "${name:-}" ] || continue
    ip="${cidr%%/*}"
    case "$ip" in 44.*) ;; *) continue ;; esac
    IFS=. read -r _ b _ _ <<<"$ip"
    case "${b:-}" in '' | *[!0-9]*) continue ;; esac
    [ "$b" -lt 192 ] || continue
    printf '%s %s\n' "$name" "$ip"
    return 0
  done < <(list_ipv4)
  return 1
}
# The address of the hamnet endpoint FED_ENDPOINTS declares, or nothing. HAMNET is what the sysop declares:
# no address range tells a HAMNET address from an internet-reachable 44Net one.
hamnet_endpoint() {
  env_get FED_ENDPOINTS | tr '{}' '\n\n' | grep '"transport":"hamnet"' | head -n 1 |
    sed -n 's/.*"address":"\([^"]*\)".*/\1/p'
}
# Whether $1 is a host name under ampr.org: lowercase labels of letters, digits and inner hyphens.
valid_ampr_host() {
  local host="$1" label labels
  case "$host" in *.ampr.org) ;; *) return 1 ;; esac
  [ "${#host}" -le 253 ] || return 1
  IFS=. read -r -a labels <<<"$host"
  for label in "${labels[@]}"; do
    printf '%s' "$label" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || return 1
  done
}
# Whether the certificate in file $1 expires within $2 days (openssl answers from the file alone).
cert_expires_within() { ! openssl x509 -checkend $(($2 * 86400)) -noout -in "$1" >/dev/null 2>&1; }

# ---- https for visitors -----------------------------------------------------------------------------
# The https port while the .env runs the https listener on tls.sh's certificate; empty otherwise (off,
# or a certificate the operator manages without tls.sh).
tls_port() {
  [ "$(env_get TLS_CERT)" = "$TLS_LEAF" ] || return 0
  env_get HTTPS_PORT
}

# ---- per-process state: $RUN_DIR/<name>.state holds KEY=VALUE lines written by supervise.sh ---------
state_file() { printf '%s/%s.state' "$RUN_DIR" "$1"; }
state_get() {
  local f
  f="$(state_file "$1")"
  [ -f "$f" ] || return 0
  { grep -E "^$2=" "$f" || true; } | tail -n 1 | cut -d= -f2-
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# A PID from a state file counts only while its command line still names what it was: a PID the system
# reused for something else is left alone.
is_ours() {
  local pid=${1:-} want=$2 args
  alive "$pid" || return 1
  args="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || ps -o args= -p "$pid" 2>/dev/null || true)"
  case "$args" in *"$want"*) return 0 ;; *) return 1 ;; esac
}
proc_entry() {
  case "$1" in
    gateway) printf 'servers/node/src/server.ts' ;;
    ingest) printf 'apps/ingest/src/index.ts' ;;
  esac
}

session_exists() { have tmux && tmux has-session -t "=$SESSION" 2>/dev/null; }

# "3d 04:05:06" style duration from seconds.
human_duration() {
  local s=$1 d h m
  d=$((s / 86400)) h=$((s % 86400 / 3600)) m=$((s % 3600 / 60))
  s=$((s % 60))
  if [ "$d" -gt 0 ]; then printf '%dd %02d:%02d:%02d' "$d" "$h" "$m" "$s"; else printf '%02d:%02d:%02d' "$h" "$m" "$s"; fi
}

# Restart one supervised process at once (its supervisor restarts it on USR1). Fails when it does not run.
restart_proc() {
  local sup
  sup="$(state_get "$1" supervisor)"
  is_ours "$sup" supervise.sh || return 1
  kill -USR1 "$sup"
  info "$1: restarting"
}
# Restart every supervised process. Fails when none is running.
restart_station() {
  local name restarted=1
  for name in "${POCKET_PROCS[@]}"; do
    if restart_proc "$name"; then restarted=0; fi
  done
  return "$restarted"
}
