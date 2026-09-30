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
  LOG_DIR="$DATA/logs"
  RUN_DIR="$DATA/run"
}
pocket_paths

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# The usage block: the comment lines after the shebang, up to the first line that is not a comment.
pocket_usage() { awk 'NR==1{next} /^#/{sub(/^# ?/, ""); print; next} {exit}' "$1"; }

# Read one KEY from the .env without exporting the rest (last assignment wins, quotes stripped).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"
}

# Export every variable of the .env into the current shell, as install.sh prints it.
env_load() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."
  set -a
  # shellcheck disable=SC1090 # the operator's own .env
  . "$ENV_FILE"
  set +a
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
# not joined or when Termux:API is missing.
WIFI_IP=""
WIFI_SSID=""
wifi_detect() {
  local wifi
  wifi="$(termux_api termux-wifi-connectioninfo)" || return 0
  [ "$(printf '%s' "$wifi" | json_field supplicant_state)" = "COMPLETED" ] || return 0
  WIFI_IP="$(printf '%s' "$wifi" | json_field ip)"
  WIFI_SSID="$(printf '%s' "$wifi" | json_field ssid)"
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
    wlan*) if [ -n "$WIFI_IP" ]; then echo "hotspot"; else echo "wlan"; fi ;;
    rndis* | usb* | ncm*) echo "usb-tether" ;;
    bt-pan* | bnep*) echo "bt-tether" ;;
    rmnet* | ccmni* | seth* | pdp* | v4-* | clat*) echo "mobile" ;;
    tun* | wg* | ppp* | ipsec*) echo "vpn" ;;
    eth* | en*) echo "ethernet" ;;
    *) echo "other" ;;
  esac
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

# Restart the supervised processes at once (each supervisor restarts its process on USR1). Fails when
# none is running.
restart_station() {
  local name sup restarted=1
  for name in "${POCKET_PROCS[@]}"; do
    sup="$(state_get "$name" supervisor)"
    if is_ours "$sup" supervise.sh; then
      kill -USR1 "$sup"
      info "$name: restarting"
      restarted=0
    fi
  done
  return "$restarted"
}
