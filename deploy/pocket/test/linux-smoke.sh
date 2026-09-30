#!/usr/bin/env bash
# Exercise the Pocket scripts on a Linux box with tmux: pocket.sh (piped into bash, as on the phone) on
# an installed checkout, recovery of a killed gateway, status, backup, https for visitors (tls.sh, with a
# stand-in `ip` that reports a hotspot address), a MeshCom node (meshcom-setup.sh), restart.sh, the Termux
# add-ons (notification, shortcuts, scheduled backup, battery saver, field alerts, USB TNC) and stop. The Termux-only commands (termux-wake-lock,
# termux-battery-status, …) are stand-ins on PATH, and tmux runs on its own socket, so an existing tmux
# session is not touched.
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
CHECK="start.sh: gateway, ingest, battery, logs, shell" check test "$(tmux list-windows -t "=$SESSION" -F '#{window_name}' | paste -sd ' ' -)" = "gateway ingest battery logs shell"
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

# With Termux:API (a stand-in) the phone has joined the Wi-Fi "Home"; the hotspot is on beside it.
printf '#!/bin/sh\necho %s\n' "'{\"supplicant_state\":\"COMPLETED\",\"ip\":\"192.168.1.183\",\"ssid\":\"Home\"}'" \
  >"$WORK/bin/termux-wifi-connectioninfo"
chmod +x "$WORK/bin/termux-wifi-connectioninfo"
printf '1: lo inet 127.0.0.1/8\n5: wlan0 inet 192.168.1.183/24\n7: wlan1 inet 192.168.43.1/24\n' >"$WORK/ifaces"
CHECK="meshcom-setup.sh: both up, no terminal: refuses to guess" check not bash "$HERE/meshcom-setup.sh" --no-write >/dev/null 2>&1
out="$(bash "$HERE/meshcom-setup.sh" --hotspot --no-write 2>&1)" || true
CHECK="meshcom-setup.sh: both up, --hotspot" check grep -q -- "--setowngw 192.168.43.1" <<<"$out"
if have script; then
  out="$(printf 'w\n192.168.1.61\n\n' | script -qc "bash $(printf '%q' "$HERE/meshcom-setup.sh") --no-write" /dev/null 2>&1)" || true
  CHECK="meshcom-setup.sh: both up, asks and takes the Wi-Fi" check grep -q -- "--extudpip 192.168.1.183" <<<"$out"
fi
printf '1: lo inet 127.0.0.1/8\n5: wlan0 inet 192.168.1.183/24\n' >"$WORK/ifaces"
CHECK="meshcom-setup.sh: on a router the node's reserved address is required" check not bash "$HERE/meshcom-setup.sh" --yes >/dev/null 2>&1
out="$(bash "$HERE/meshcom-setup.sh" --node-ip 192.168.1.60 --yes 2>&1)" || true
CHECK="meshcom-setup.sh: hotspot off, the joined Wi-Fi" check grep -q "hotspot is off; using the Wi-Fi network Home" <<<"$out"
CHECK="meshcom-setup.sh: ExtUDP to the phone's Wi-Fi address" check grep -q -- "--extudpip 192.168.1.183" <<<"$out"
CHECK="meshcom-setup.sh: the router's network name" check grep -q -- "--setssid Home" <<<"$out"
CHECK="meshcom-setup.sh: no fixed-address commands on a router" check not grep -q -- "^    --setownip" <<<"$out"
CHECK="meshcom-setup.sh: the node on the router replaces its hotspot entry" check test "$(env_get MESHCOM_NODE)" = "192.168.1.60=N0CALL-12"

gw="$(proc_pid gateway)"
bash "$HERE/restart.sh" gateway >/dev/null
CHECK="restart.sh gateway: healthy again" check wait_health 30
CHECK="restart.sh gateway: a new process" check test "$(proc_pid gateway)" != "$gw"

# ---- the Termux add-ons, with stand-ins that record how they are called
for cmd in termux-notification termux-notification-remove termux-toast termux-job-scheduler; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >>"%s/api-calls"\n' "$cmd" "$WORK" >"$WORK/bin/$cmd"
  chmod +x "$WORK/bin/$cmd"
done
bash "$HERE/start.sh" --no-attach >/dev/null 2>&1
CHECK="start.sh: the notify window with Termux:API" check grep -qxF notify <<<"$(tmux list-windows -t "=$SESSION" -F '#{window_name}')"
: >"$WORK/api-calls"
bash "$HERE/extras/notify.sh" --once
call="$(grep -m1 '^termux-notification ' "$WORK/api-calls" || true)"
CHECK="notify.sh: an ongoing notification with the station's id" check grep -q -- "--id aprscaching --ongoing" <<<"$call"
CHECK="notify.sh: running, stations heard, battery" check grep -qE "aprscaching: running.*stations heard in the last hour.*battery 80%" <<<"$call"
CHECK="notify.sh: Stop, Restart and Open map" check grep -qE "button1 Stop.*button2 Restart.*button3 Open map" <<<"$call"
CHECK="station-status: operator secret required" check test "$(curl -s -o /dev/null -w '%{http_code}' "$(gateway_base)/api/admin/station-status")" = 403

export APRSCACHING_SHORTCUTS_DIR="$WORK/shortcuts" APRSCACHING_BACKUP_DIR="$WORK/backups"
bash "$HERE/extras/setup.sh" --shortcuts --scheduled-backup >/dev/null
CHECK="extras/setup.sh: five shortcuts" check test "$(find "$WORK/shortcuts" -type f -perm -u+x | wc -l)" -eq 5
CHECK="extras/setup.sh: background shortcuts under tasks/" check test -x "$WORK/shortcuts/tasks/aprscaching Start"
CHECK="extras/setup.sh: a daily job while charging" check grep -qE "termux-job-scheduler --job-id 4287 --script .* --period-ms 86400000 --charging true" "$WORK/api-calls"
job="$RUN_DIR/scheduled-backup-job.sh"
bash "$job" && ok_backup=1 || ok_backup=0
CHECK="scheduled backup: runs and records the time" check test "$ok_backup" = 1 -a -s "$RUN_DIR/last-backup"
out="$(bash "$HERE/status.sh" 2>&1)" || true
CHECK="status.sh: the last backup" check grep -q "last backup: 00:00:0" <<<"$out"
printf '#!/bin/sh\necho %s\n' "'{\"percentage\":30,\"plugged\":\"PLUGGED_AC\"}'" >"$WORK/bin/termux-battery-status"
rm -f "$RUN_DIR/last-backup"
bash "$job"
CHECK="scheduled backup: skipped below 50 % battery" check test ! -e "$RUN_DIR/last-backup"
bash "$HERE/extras/setup.sh" --remove >/dev/null
CHECK="extras/setup.sh --remove: shortcuts gone, job cancelled" check test -z "$(find "$WORK/shortcuts" -type f)" -a -n "$(grep -- '--cancel --job-id 4287' "$WORK/api-calls")"

# ---- the battery saver, with stand-in battery readings
battery() { printf '#!/bin/sh\necho %s\n' "'{\"percentage\":$1,\"plugged\":\"$2\"}'" >"$WORK/bin/termux-battery-status"; }
ing="$(state_get ingest restarts)"
battery 15 UNPLUGGED
bash "$HERE/extras/battery.sh" --once >/dev/null
CHECK="battery.sh: saver below 20 % on battery" check grep -q "^APRSIS_FILTER='b/N0CALL\*'" "$SAVER_ENV"
sleep 2
CHECK="battery.sh: the station restarted into the saver profile" check test "$(state_get ingest restarts)" -gt "$ing"
CHECK="battery.sh: one notification" check grep -q "aprscaching-battery --title aprscaching: battery saver on" "$WORK/api-calls"
CHECK="status.sh: battery saver ON" check grep -q "battery saver: ON" <<<"$(bash "$HERE/status.sh" 2>&1 || true)"
battery 25 UNPLUGGED
bash "$HERE/extras/battery.sh" --once >/dev/null
CHECK="battery.sh: stays in saver below 30 % (hysteresis)" check test -f "$SAVER_ENV"
battery 25 PLUGGED_AC
bash "$HERE/extras/battery.sh" --once >/dev/null
CHECK="battery.sh: normal again when charging" check test ! -f "$SAVER_ENV"
battery 80 UNPLUGGED
decided="$(for c in "30 0 normal" "19 0 normal" "19 1 normal" "25 0 saver" "29 0 saver" "30 0 saver" "10 1 saver"; do
  # shellcheck disable=SC2086 # the three words of each case
  bash "$HERE/extras/battery.sh" --decide $c
done | paste -sd ' ' -)"
CHECK="battery.sh: the rule, with the 10-point gap" check test "$decided" = "normal saver normal saver saver normal normal"

# ---- field alerts: a message to the operator's call makes the phone vibrate and speak the sender
for cmd in termux-vibrate termux-tts-speak; do
  printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >>"%s/api-calls"\n' "$cmd" "$WORK" >"$WORK/bin/$cmd"
  chmod +x "$WORK/bin/$cmd"
done
wait_health 60 || true # the battery saver restarted the station just now
CHECK="alerts.sh: off by default" check grep -q "field alerts off" <<<"$(bash "$HERE/extras/alerts.sh" --once 2>&1)"
printf 'POCKET_ALERTS=1\nPOCKET_ALERTS_SPEAK=1\n' >>"$ENV_FILE"
bash "$HERE/extras/alerts.sh" --once >/dev/null # the first run starts from now
message() {
  (cd "$DIR/servers/node" && node -e '
    const D = require("better-sqlite3"), db = new D(process.argv[1]);
    db.prepare("INSERT INTO messages (ts, from_call, to_call, body, ack, direction) VALUES (?,?,?,?,NULL,\x27rx\x27)")
      .run(Number(process.argv[2]), process.argv[3], process.argv[4], process.argv[5]);' \
    "$(env_get DB_PATH)" "$1" "$2" "$3" "$4")
}
t=$(($(date +%s) + 2))
message "$t" OE8XYZ N0CALL-7 "meet at the cache"
: >"$WORK/api-calls"
bash "$HERE/extras/alerts.sh" --once >/dev/null
CHECK="alerts.sh: vibrates for a message to the operator's call" check grep -q "^termux-vibrate" "$WORK/api-calls"
CHECK="alerts.sh: says who it is from, not the text" check grep -qx "termux-tts-speak Message from O E 8 X Y Z" "$WORK/api-calls"
: >"$WORK/api-calls"
bash "$HERE/extras/alerts.sh" --once >/dev/null
CHECK="alerts.sh: announces a message once" check test ! -s "$WORK/api-calls"
message $((t + 1)) OE8AAA N0CALL "one"
message $((t + 1)) OE8BBB N0CALL "two"
message $((t + 1)) OE8CCC OE5OTH "not for us"
printf 'POCKET_ALERTS_SPEAK_BODY=1\n' >>"$ENV_FILE"
bash "$HERE/extras/alerts.sh" --once >/dev/null
CHECK="alerts.sh: two messages in one second both announced, others' mail not" check test "$(grep -c '^termux-vibrate' "$WORK/api-calls")" -eq 2
CHECK="alerts.sh: the text only when POCKET_ALERTS_SPEAK_BODY=1" check grep -qx "termux-tts-speak Message from O E 8 B B B. two" "$WORK/api-calls"

# ---- a USB KISS TNC (the bridge itself is covered by extras/test; here the wiring)
cat >"$WORK/bin/termux-usb" <<'USB'
#!/bin/sh
case "$1" in
  -l) echo '["/dev/bus/usb/001/002"]' ;;
  -r) exit 0 ;;
  -e) sleep 1; exit 3 ;;
esac
USB
chmod +x "$WORK/bin/termux-usb"
CHECK="usb-kiss.sh --list: the attached device" check test "$(bash "$HERE/extras/usb-kiss.sh" --list)" = /dev/bus/usb/001/002
bash "$HERE/extras/usb-kiss.sh" --setup --baud 1200 >/dev/null
CHECK="usb-kiss.sh --setup: device and baud in the .env" check test "$(env_get USB_KISS_DEVICE):$(env_get USB_KISS_BAUD)" = /dev/bus/usb/001/002:1200
CHECK="usb-kiss.sh --setup: the ingest reads KISS at 127.0.0.1:8001" check test "$(env_get KISS_TNC_HOST):$(env_get KISS_TNC_PORT)" = 127.0.0.1:8001
CHECK="start.sh: the usb-kiss window" check grep -qxF usb-kiss <<<"$(tmux list-windows -t "=$SESSION" -F '#{window_name}')"
CHECK="status.sh: the USB TNC, receive-only" check grep -q "USB KISS TNC: /dev/bus/usb/001/002, 1200 baud, receive-only" <<<"$(bash "$HERE/status.sh" 2>&1 || true)"

gw="$(proc_pid gateway)"
bash "$HERE/stop.sh" >/dev/null
CHECK="stop.sh: the session is gone" check not session_exists
CHECK="stop.sh: the gateway is gone" check not alive "$gw"
CHECK="stop.sh: no /health" check not health_ok "$(gateway_base)" 2
CHECK="stop.sh: wake lock released" check grep -qx termux-wake-unlock "$WORK/calls"
CHECK="stop.sh: the notification removed" check grep -q "^termux-notification-remove aprscaching" "$WORK/api-calls"

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
echo "all checks passed"
