#!/usr/bin/env bash
# Exercise the Pocket scripts on a Linux box with tmux: pocket.sh (piped into bash, as on the phone) on
# an installed checkout, recovery of a killed gateway, status, backup, https for visitors (tls.sh, with a
# stand-in `ip` that reports a hotspot address), a MeshCom node (meshcom-setup.sh), restart.sh and stop. The Termux-only commands (termux-wake-lock, termux-battery-status, …) are
# stand-ins on PATH, and tmux runs on its own socket, so an existing tmux session is not touched.
#
#   bash deploy/pocket/install.sh --allow-non-termux --dir ~/pocket-test --data-dir ~/pocket-test-data --port 8951 --call N0CALL
#   bash deploy/pocket/test/linux-smoke.sh --dir ~/pocket-test --data-dir ~/pocket-test-data
#
# Needs an installed checkout and data directory (install.sh above) with a free PORT in its .env.
#
# Options:
#   --dir PATH           the installed checkout         (APRSCACHING_DIR)
#   --data-dir PATH      its data directory             (APRSCACHING_DATA)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
have tmux || die "tmux is missing (apt install tmux)."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing: run install.sh first (see --help)."
export APRSCACHING_DIR="$DIR" APRSCACHING_DATA="$DATA"

WORK="$(mktemp -d)"
export TMUX_TMPDIR="$WORK/tmux"
mkdir -p "$TMUX_TMPDIR" "$WORK/bin" "$WORK/backups"
for cmd in termux-wake-lock termux-wake-unlock; do
  printf '#!/bin/sh\necho %s >>"%s/calls"\n' "$cmd" "$WORK" >"$WORK/bin/$cmd"
done
printf '#!/bin/sh\necho %s\n' "'{\"percentage\":80,\"status\":\"DISCHARGING\",\"plugged\":\"UNPLUGGED\",\"temperature\":30.5}'" \
  >"$WORK/bin/termux-battery-status"
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"
finish() {
  bash "$HERE/stop.sh" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap finish EXIT

fails=0
check() {
  if "$@"; then printf 'ok    %s\n' "$CHECK"; else printf 'FAIL  %s\n' "$CHECK"; fails=$((fails + 1)); fi
}
wait_health() {
  local i
  for ((i = 0; i < $1; i++)); do
    health_ok "$(gateway_base)" 2 && return 0
    sleep 1
  done
  return 1
}
proc_pid() { state_get "$1" pid; }
not() { ! "$@"; }

# pocket.sh fetches install.sh from <APRSCACHING_RAW>/<branch>/…; point it at this checkout's copy.
mkdir -p "$WORK/raw/local/deploy/pocket"
ln -s "$DIR/deploy/pocket/install.sh" "$WORK/raw/local/deploy/pocket/install.sh"
out="$(APRSCACHING_RAW="file://$WORK/raw" bash -s -- --allow-non-termux --branch local --no-update \
  <"$HERE/pocket.sh" 2>&1)" || printf '%s\n' "$out" | tail -n 20 >&2
CHECK="pocket.sh: the gateway answers /health" check wait_health 60
CHECK="pocket.sh: prints the local URL" check grep -q "on this phone: *http://localhost:" <<<"$out"
CHECK="pocket.sh: prints a sign-in link" check grep -q "/auth/email/verify?token=" <<<"$out"
CHECK="start.sh: four windows" check test "$(tmux list-windows -t "=$SESSION" | wc -l)" -eq 4
CHECK="start.sh: wake lock taken" check grep -qx termux-wake-lock "$WORK/calls"

old="$(proc_pid gateway)"
kill -KILL "$old"
sleep 2
CHECK="supervise.sh: the killed gateway is down" check test "$(state_get gateway restarts)" -eq 1
CHECK="supervise.sh: the gateway is back after the backoff" check wait_health 30
CHECK="supervise.sh: under a new PID" check test "$(proc_pid gateway)" != "$old"

out="$(bash "$HERE/status.sh" 2>&1)" || true
CHECK="status.sh: the gateway runs, restarted once" check grep -q "gateway  running, .*restarts 1" <<<"$out"
CHECK="status.sh: /health OK" check grep -q "/health: OK" <<<"$out"
CHECK="status.sh: battery" check grep -q "80%, DISCHARGING" <<<"$out"

bash "$HERE/backup.sh" --dest "$WORK/backups" --no-env >/dev/null
archive="$(find "$WORK/backups" -name 'aprscaching-pocket-*.tar.gz' | head -n 1)"
CHECK="backup.sh: an archive" check test -n "$archive"
if [ -n "$archive" ]; then
  mkdir -p "$WORK/x"
  tar -xzf "$archive" -C "$WORK/x"
  tables="$(cd "$DIR/servers/node" && node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});console.log(db.prepare("select count(*) n from sqlite_master where type = ?").get("table").n)' "$WORK"/x/*/aprscaching.db)"
  CHECK="backup.sh: the snapshot opens and has tables ($tables)" check test "$tables" -gt 0
  CHECK="backup.sh: --no-env leaves the secrets out" check test ! -e "$(echo "$WORK"/x/*/env)"
fi

# ---- https for visitors. The stand-in `ip` reports a hotspot address the certificate must name; the
# gateway is reached on 127.0.0.1, which the certificate always names too.
HP=$(($(gateway_port) + 1))
printf '1: lo inet 127.0.0.1/8 scope host lo\n9: ap0 inet 192.168.43.1/24 scope global ap0\n' >"$WORK/ifaces"
printf '#!/bin/sh\ncat "%s"\n' "$WORK/ifaces" >"$WORK/bin/ip"
chmod +x "$WORK/bin/ip"
# The tls window takes its environment from the tmux server, which runs already.
tmux set-environment -g APRSCACHING_TLS_WATCH_S 1
https_ok() {
  local i
  for ((i = 0; i < $1; i++)); do
    curl -fsS -o /dev/null --max-time 2 --cacert "$TLS_CA" "https://127.0.0.1:$HP/health" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
served_names() {
  openssl s_client -connect "127.0.0.1:$HP" -servername localhost </dev/null 2>/dev/null |
    openssl x509 -noout -ext subjectAltName 2>/dev/null
}
bash "$HERE/tls.sh" --port "$HP" >/dev/null
CHECK="tls.sh: the gateway answers https with the station CA" check https_ok 60
CHECK="tls.sh: the .env runs https on tls.sh's certificate" check test "$(tls_port)" = "$HP"
CHECK="tls.sh: visitor links opted in" check test "$(env_get OPERATOR_LINKS_FOR_ANY_CALL)" = 1
CHECK="tls.sh: the key is private" check test "$(stat -c %a "$TLS_LEAF_KEY")" = 600
CHECK="tls.sh: the CA is name-constrained" check grep -q "Name Constraints" <<<"$(openssl x509 -noout -text -in "$TLS_CA")"
CHECK="tls.sh: the certificate names the hotspot" check grep -q "IP Address:192.168.43.1" <<<"$(served_names)"
CHECK="tls.sh: the CA is served at /pocket-ca.crt" check cmp -s "$TLS_CA" <(curl -fsS "$(gateway_base)/pocket-ca.crt")
CHECK="start.sh: the tls window" check grep -qxF tls <<<"$(tmux list-windows -t "=$SESSION" -F '#{window_name}')"
out="$(bash "$HERE/status.sh" 2>&1)" || true
CHECK="status.sh: the https listener" check grep -q "port $HP; the certificate names 127.0.0.1 192.168.43.1" <<<"$out"
out="$(bash "$HERE/signin-link.sh" --hotspot N0VIS 2>&1)" || true
CHECK="signin-link.sh --hotspot: a link at the hotspot origin" check grep -q "https://192.168.43.1:$HP/auth/email/verify?token=" <<<"$out"
CHECK="signin-link.sh --hotspot: a QR code" check grep -q "█" <<<"$out"

gw="$(proc_pid gateway)"
issued="$(openssl x509 -noout -serial -in "$TLS_LEAF")"
printf '1: lo inet 127.0.0.1/8 scope host lo\n' >"$WORK/ifaces"
sleep 4
CHECK="tls.sh --watch: the hotspot turned off keeps the certificate" check test "$(openssl x509 -noout -serial -in "$TLS_LEAF")" = "$issued"
printf '1: lo inet 127.0.0.1/8 scope host lo\n9: ap0 inet 192.168.44.1/24 scope global ap0\n' >"$WORK/ifaces"
renewed() {
  local i
  for ((i = 0; i < 20; i++)); do
    grep -q "IP Address:192.168.44.1" <<<"$(served_names)" && return 0
    sleep 1
  done
  return 1
}
CHECK="tls.sh --watch: a new hotspot address is served without a restart" check renewed
CHECK="tls.sh --watch: the same gateway process" check test "$(proc_pid gateway)" = "$gw"

bash "$HERE/tls.sh" --disable >/dev/null
CHECK="tls.sh --disable: the https settings are gone" check test -z "$(env_get HTTPS_PORT)"
CHECK="tls.sh --disable: the gateway is back on plain http" check wait_health 60
sleep 3
CHECK="tls.sh --disable: no https" check not curl -fsS -o /dev/null --max-time 2 -k "https://127.0.0.1:$HP/health" 2>/dev/null
CHECK="tls.sh --disable: the tls window closed" check not grep -qxF tls <<<"$(tmux list-windows -t "=$SESSION" -F '#{window_name}')"

# ---- a MeshCom node on the hotspot (the stand-in `ip` reports the hotspot 192.168.43.1/24)
printf '1: lo inet 127.0.0.1/8 scope host lo\n9: ap0 inet 192.168.43.1/24 scope global ap0\n' >"$WORK/ifaces"
ing="$(state_get ingest restarts)"
out="$(bash "$HERE/meshcom-setup.sh" --call n0call-12 --ssid FieldKit --yes 2>&1)" || true
CHECK="meshcom-setup.sh: a fixed address high in the hotspot subnet" check grep -q -- "--setownip 192.168.43.254" <<<"$out"
CHECK="meshcom-setup.sh: the phone as the node's gateway" check grep -q -- "--setowngw 192.168.43.1" <<<"$out"
CHECK="meshcom-setup.sh: the hotspot's mask" check grep -q -- "--setownms 255.255.255.0" <<<"$out"
CHECK="meshcom-setup.sh: ExtUDP to the phone" check grep -q -- "--extudpip 192.168.43.1" <<<"$out"
CHECK="meshcom-setup.sh: the hotspot name" check grep -q -- "--setssid FieldKit" <<<"$out"
CHECK="meshcom-setup.sh: MESHCOM_NODE written" check test "$(env_get MESHCOM_NODE)" = "192.168.43.254=N0CALL-12"
sleep 2
CHECK="meshcom-setup.sh: the ingest restarted" check test "$(state_get ingest restarts)" -gt "$ing"
bash "$HERE/meshcom-setup.sh" --node-ip 192.168.43.50 --yes >/dev/null 2>&1 || true
CHECK="meshcom-setup.sh: a new address replaces the node's entry" check test "$(env_get MESHCOM_NODE)" = "192.168.43.50=N0CALL-12"
bash "$HERE/meshcom-setup.sh" --yes >/dev/null 2>&1 || true
CHECK="meshcom-setup.sh: a configured node keeps its address and call" check test "$(env_get MESHCOM_NODE)" = "192.168.43.50=N0CALL-12"
CHECK="meshcom-setup.sh: an address outside the subnet is refused" check not bash "$HERE/meshcom-setup.sh" --call N0CALL-12 --node-ip 10.0.0.5 --yes >/dev/null 2>&1
out="$(bash "$HERE/status.sh" 2>&1)" || true
CHECK="status.sh: the MeshCom node" check grep -q "MeshCom ExtUDP: UDP 1799, nodes 192.168.43.50=N0CALL-12" <<<"$out"

gw="$(proc_pid gateway)"
bash "$HERE/restart.sh" gateway >/dev/null
CHECK="restart.sh gateway: healthy again" check wait_health 30
CHECK="restart.sh gateway: a new process" check test "$(proc_pid gateway)" != "$gw"

gw="$(proc_pid gateway)"
bash "$HERE/stop.sh" >/dev/null
CHECK="stop.sh: the session is gone" check not session_exists
CHECK="stop.sh: the gateway is gone" check not alive "$gw"
CHECK="stop.sh: no /health" check not health_ok "$(gateway_base)" 2
CHECK="stop.sh: wake lock released" check grep -qx termux-wake-unlock "$WORK/calls"

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
echo "all checks passed"
