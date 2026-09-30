#!/usr/bin/env bash
# Exercise the Pocket scripts on a Linux box with tmux: pocket.sh (piped into bash, as on the phone) on
# an installed checkout, recovery of a killed gateway, status, backup and stop. The Termux-only commands (termux-wake-lock, termux-battery-status, …) are
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

out="$(bash "$HERE/status.sh" 2>&1)"
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

gw="$(proc_pid gateway)"
bash "$HERE/stop.sh" >/dev/null
CHECK="stop.sh: the session is gone" check not session_exists
CHECK="stop.sh: the gateway is gone" check not alive "$gw"
CHECK="stop.sh: no /health" check not health_ok "$(gateway_base)" 2
CHECK="stop.sh: wake lock released" check grep -qx termux-wake-unlock "$WORK/calls"

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
echo "all checks passed"
