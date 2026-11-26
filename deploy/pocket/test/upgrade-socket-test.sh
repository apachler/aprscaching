#!/usr/bin/env bash
# An update moves a running station onto the gateway's socket at once, with no step by the operator. The
# helper windows (notify, alerts, the USB KISS bridge's loop) run the loop of the script they started with,
# and the lib.sh it read then: a helper of an earlier release goes on sending OPERATOR_SECRET to
# 127.0.0.1:PORT, where any app on the phone may listen, until its window is respawned. An earlier release's
# update.sh or pocket.sh restarts only the gateway and the ingest, so the move runs from install.sh, which
# every update runs, through lib.sh's pocket_move_onto_sockets.
#
# Each station: a stand-in for another app holds the gateway's TCP port; a stand-in supervisor whose gateway
# serves GATEWAY_SOCKET once the .env names it and it is restarted (USR1, as supervise.sh does); helper windows
# in a stand-in tmux whose script is an earlier release's station_status loop. The update replaces the scripts
# on disk, as git does, then runs install.sh itself on the kept .env, with stand-ins for the toolchain it checks
# (corepack, better-sqlite3) and a web build handed in. After it the TCP port must see no secret and the socket
# must see the respawned helpers. The stations: one with a USB TNC, one without, and one whose alerts window
# fails to respawn, where install.sh names that window and finishes the move. Runs anywhere with bash, curl,
# git, node and setsid; no Termux, no tmux, no gateway.
#
#   bash deploy/pocket/test/upgrade-socket-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POCKET="$ROOT/deploy/pocket"
# A short base: a socket path is limited to 107 bytes.
WORK="$(mktemp -d)"
FAILS=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  FAILS=$((FAILS + 1))
}
PIDS=()
cleanup() {
  local d
  for d in "$WORK"/tmux/*/; do [ -d "$d" ] && tmux kill-session -t "=$(basename "$d")" 2>/dev/null; done
  kill "${PIDS[@]}" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- a stand-in tmux: a window is a process group running its command ----------------------------------
# $FAKE_TMUX/<session>/<window>.cmd holds the command, .pid the group's leader. respawn-window -k ends the
# group and runs the command again, as tmux does; it fails for the window FAKE_TMUX_FAIL names, as tmux does for
# a window closed since the list was read.
mkdir -p "$WORK/bin" "$WORK/tmux"
cat >"$WORK/bin/tmux" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
D="${FAKE_TMUX:?}"
S="" W="" C=""
split() { local t=${1#=}; S=${t%%:*}; W=""; case "$t" in *:*) W=${t#*:} ;; esac; }
run() {
  mkdir -p "$D/$S"
  printf '%s' "$C" >"$D/$S/$W.cmd"
  setsid bash -c "$C" </dev/null >>"$D/$S/$W.log" 2>&1 &
  echo $! >"$D/$S/$W.pid"
}
stop() { local p; p="$(cat "$D/$S/$1.pid" 2>/dev/null || true)"; [ -z "$p" ] || kill -TERM -- "-$p" 2>/dev/null || true; }
sub=$1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -s) S=$2; shift ;;
    -t) split "$2"; shift ;;
    -n) W=$2; shift ;;
    -c | -F) shift ;;
    -d | -k) ;;
    *) C=$1 ;;
  esac
  shift
done
case "$sub" in
  has-session) [ -d "$D/$S" ] ;;
  new-session | new-window) run ;;
  list-windows) for f in "$D/$S"/*.cmd; do [ -e "$f" ] && basename "$f" .cmd; done; true ;;
  respawn-window)
    if [ "$W" = "${FAKE_TMUX_FAIL:-}" ]; then echo "can't respawn window $W" >&2; exit 1; fi
    stop "$W"; C="$(cat "$D/$S/$W.cmd")"; run ;;
  kill-session) for f in "$D/$S"/*.pid; do [ -e "$f" ] && stop "$(basename "$f" .pid)"; done; rm -rf "${D:?}/$S" ;;
  *) echo "stand-in tmux: $sub is not supported" >&2; exit 2 ;;
esac
SH
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH" FAKE_TMUX="$WORK/tmux" APRSCACHING_START_WAIT=20
SECRET=deadbeefsecret

# ---- what install.sh checks before the .env: the toolchain and a web build -----------------------------
# corepack answers for pnpm; node answers the better-sqlite3 check (the test needs no native build) and runs
# everything else as itself; python3, make and cc need only exist.
REAL_NODE="$(command -v node)"
mkdir -p "$WORK/ibin" "$WORK/web"
printf '<!doctype html>\n' >"$WORK/web/index.html"
printf '#!/bin/sh\n[ "${2:-}" = --version ] && echo stand-in\nexit 0\n' >"$WORK/ibin/corepack"
cat >"$WORK/ibin/node" <<SH
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in "-e "*better-sqlite3*) echo "SQLite stand-in"; exit 0 ;; esac
exec "$REAL_NODE" "\$@"
SH
# The checkout install.sh is pointed at: its own repository whose deploy/ is this one's, so install.sh runs this
# tree's scripts and writes nothing into it.
CHECKOUT="$WORK/checkout"
mkdir -p "$CHECKOUT/servers/node/src"
: >"$CHECKOUT/servers/node/src/server.ts"
ln -s "$ROOT/deploy" "$CHECKOUT/deploy"
git -C "$CHECKOUT" init -q
git -C "$CHECKOUT" -c user.name=test -c user.email=test@invalid commit -q --allow-empty -m checkout
for t in python3 make cc; do command -v "$t" >/dev/null || printf '#!/bin/sh\nexit 0\n' >"$WORK/ibin/$t"; done
chmod +x "$WORK"/ibin/*

# ---- the other app on the TCP port, and the gateway on the socket ------------------------------------
# Each logs "<listener> <path> <secret or ->" and answers what station_status parses.
cat >"$WORK/listen.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const [where, log] = process.argv.slice(2);
const srv = http.createServer((req, res) => {
  fs.appendFileSync(log, `${where.startsWith("/") ? "socket" : "tcp"} ${req.url} ${req.headers["x-operator-secret"] ?? "-"}\n`);
  res.setHeader("content-type", "application/json");
  res.end(req.url === "/health" ? '{"ok":true}' : '{"operatorVerified":true}');
});
if (where.startsWith("/")) srv.listen(where);
else srv.listen(Number(where), "127.0.0.1");
process.on("SIGTERM", () => srv.close(() => process.exit(0)));
JS

# A stand-in supervise.sh for the gateway: it starts the gateway from the .env (a socket only once the .env
# names one) and restarts it on USR1, and leaves the state file restart_station reads.
mkdir -p "$WORK/sup"
cat >"$WORK/sup/supervise.sh" <<'SH'
#!/usr/bin/env bash
set -u
env_file=$1 listen=$2 log=$3 state=$4
child=""
start() {
  [ -z "$child" ] || { kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }
  sock="$(grep -E '^GATEWAY_SOCKET=' "$env_file" | tail -n 1 | cut -d= -f2-)"
  child=""
  if [ -n "$sock" ]; then node "$listen" "$sock" "$log" & child=$!; fi
  printf 'supervisor=%s\npid=%s\n' "$$" "$child" >"$state"
}
trap start USR1
trap '[ -z "$child" ] || kill "$child"; exit 0' TERM
start
while :; do sleep 0.2; done
SH

# ---- the helper windows' scripts ---------------------------------------------------------------------
# lib.sh's station_status of an earlier release: the secret to the gateway's TCP port.
mkdir -p "$WORK/scripts"
cat >"$WORK/scripts/old-helper.sh" <<'SH'
env_get() { { grep -E "^$1=" "$APRSCACHING_DATA/.env" || true; } | tail -n 1 | cut -d= -f2-; }
gateway_base() { printf 'http://127.0.0.1:%s' "$(env_get PORT)"; }
station_status() {
  local secret
  secret="$(env_get OPERATOR_SECRET)"
  [ -n "$secret" ] || return 1
  curl -fsS --max-time 5 -H @<(printf 'x-operator-secret: %s\n' "$secret") \
    "$(gateway_base)/api/admin/station-status${1:+?since=$1}" 2>/dev/null
}
while :; do station_status "" >/dev/null || true; sleep 0.3; done
SH
# This release's helper loop: lib.sh's station_status, as notify.sh and alerts.sh call it.
cat >"$WORK/scripts/new-helper.sh" <<SH
. "$POCKET/lib.sh"
while :; do station_status "" >/dev/null || true; sleep 0.3; done
SH

# station NAME FAIL_WINDOW ENV_LINE…: a station installed by an earlier release, running on an .env of those
# lines, updated. FAIL_WINDOW names the window whose respawn fails, or is empty.
station() {
  local name=$1 failw=$2 data="$WORK/$1" w port before out status leaked on_socket
  shift 2
  local log="$WORK/$name.log" scripts="$WORK/$name.scripts"
  echo "== $name"
  mkdir -p "$data/run" "$scripts"
  chmod 700 "$data" "$data/run"
  port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  printf '%s\n' "PORT=$port" "OPERATOR_SECRET=$SECRET" "$@" >"$data/.env"
  chmod 600 "$data/.env"
  node "$WORK/listen.mjs" "$port" "$log" &
  PIDS+=($!)
  bash "$WORK/sup/supervise.sh" "$data/.env" "$WORK/listen.mjs" "$log" "$data/run/gateway.state" &
  PIDS+=($!)

  export APRSCACHING_DATA="$data" APRSCACHING_SESSION="acs-$name"
  for w in notify alerts usb-kiss; do cp "$WORK/scripts/old-helper.sh" "$scripts/$w.sh"; done
  tmux new-session -d -s "$APRSCACHING_SESSION" -n gateway "sleep 600"
  for w in notify alerts usb-kiss; do tmux new-window -d -t "=$APRSCACHING_SESSION:" -n "$w" "bash $scripts/$w.sh"; done
  tmux new-window -d -t "=$APRSCACHING_SESSION:" -n shell "sleep 600"
  : >"$log"
  for _ in $(seq 1 50); do
    grep -q "^tcp .* $SECRET\$" "$log" && break
    sleep 0.2
  done
  before="$(grep -c "^tcp .* $SECRET\$" "$log" || true)"
  if [ "$before" -gt 0 ]; then pass "before the update the earlier helpers send the secret to TCP ($before requests)"; else
    fail "the earlier helpers sent nothing before the update: the check after it would prove nothing"
  fi
  declare -A oldpid
  for w in notify alerts usb-kiss shell; do oldpid[$w]="$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/$w.pid")"; done

  # The update: git replaces the scripts, then install.sh runs on the kept .env.
  for w in notify alerts usb-kiss; do cp "$WORK/scripts/new-helper.sh" "$scripts/$w.sh"; done
  status=0
  out="$(PATH="$WORK/ibin:$PATH" FAKE_TMUX_FAIL="$failw" bash "$POCKET/install.sh" --allow-non-termux --skip-pkg \
    --no-update --no-next-steps --dir "$CHECKOUT" --data-dir "$data" --web-dist "$WORK/web" 2>&1)" || status=$?
  printf '%s\n' "$out" >"$WORK/$name.install.log"
  if [ "$status" -eq 0 ]; then pass "install.sh finishes"; else
    fail "install.sh exited $status:"
    tail -n 8 <<<"$out" | sed 's/^/       /'
  fi
  : >"$log"
  sleep 2

  if grep -qx "GATEWAY_SOCKET=$data/run/gateway.sock" "$data/.env"; then pass "the .env names the gateway's socket"; else
    fail "the .env names no gateway socket"
  fi
  if [ -z "$failw" ]; then
    leaked="$(grep "^tcp " "$log" | grep -v -- ' -$' || true)"
    if [ -z "$leaked" ]; then pass "after the update no helper sends the secret to the TCP port"; else
      fail "after the update the TCP port still received the secret:"
      sed 's/^/       /' <<<"$leaked"
    fi
  fi
  on_socket="$(grep -c "^socket /api/admin/station-status $SECRET\$" "$log" || true)"
  if [ "$on_socket" -gt 0 ]; then pass "the respawned helpers reach the gateway on its socket ($on_socket requests)"; else
    fail "the gateway's socket saw no helper after the update"
  fi
  for w in notify alerts usb-kiss; do
    [ "$w" != "$failw" ] || continue
    if [ "$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/$w.pid")" != "${oldpid[$w]}" ]; then pass "the $w window was respawned"; else
      fail "the $w window runs the loop it started with"
    fi
  done
  if [ "$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/shell.pid")" = "${oldpid[shell]}" ]; then pass "  … and the shell window was left alone"; else
    fail "the shell window was respawned"
  fi
  if [ -n "$failw" ]; then
    # The operator learns which window still runs the earlier loop, and how to load the new one.
    if grep -q "WARNING: the $failw window did not restart.*stop\.sh, then .*start\.sh" <<<"$out"; then
      pass "install.sh names the $failw window and says to run stop.sh, then start.sh"
      grep "WARNING: the $failw window" <<<"$out" | sed 's/^/       /'
    else fail "install.sh does not warn that the $failw window did not restart, with stop.sh and start.sh"; fi
  fi
}

station usb "" USB_KISS_DEVICE=/dev/bus/usb/001/002 KISS_TNC_HOST=127.0.0.1 KISS_TNC_PORT=8001
if grep -qx "KISS_TNC_HOST=$WORK/usb/run/kiss.sock" "$WORK/usb/.env"; then pass "the .env names the USB TNC's socket"; else
  fail "the USB TNC's KISS_TNC_HOST was not moved to its socket"
fi
station no-tnc ""
station respawn-fails alerts USB_KISS_DEVICE=/dev/bus/usb/001/002 KISS_TNC_HOST=127.0.0.1 KISS_TNC_PORT=8001

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed" >&2
  exit 1
fi
echo "all upgrade-socket checks passed"
