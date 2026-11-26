#!/usr/bin/env bash
# An update moves a running station onto the gateway's socket at once, with no step by the operator. The
# helper windows (notify, alerts, the USB KISS bridge's loop) run the loop of the script they started with,
# and the lib.sh it read then: a helper of an earlier release goes on sending OPERATOR_SECRET to
# 127.0.0.1:PORT, where any app on the phone may listen, until its window is respawned. An earlier release's
# update.sh or pocket.sh restarts only the gateway and the ingest, so the move runs from install.sh, through
# lib.sh's pocket_sockets_env and pocket_restart_on_sockets.
#
# A stand-in for another app holds the gateway's TCP port. A running station on an earlier .env: a stand-in
# supervisor whose gateway serves GATEWAY_SOCKET once the .env names it and it is restarted (USR1, as
# supervise.sh does), and helper windows in a stand-in tmux whose script is an earlier release's
# station_status loop. The update replaces the scripts on disk, as git does, then runs what install.sh runs.
# After it the TCP port must see no secret, the socket must see the respawned helpers, and install.sh must run
# the restart. Runs anywhere with bash, curl, node and setsid; no Termux, no tmux, no gateway.
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

# ---- a stand-in tmux: a window is a process group running its command ----------------------------------
# $FAKE_TMUX/<session>/<window>.cmd holds the command, .pid the group's leader. respawn-window -k ends the
# group and runs the command again, as tmux does.
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
  respawn-window) stop "$W"; C="$(cat "$D/$S/$W.cmd")"; run ;;
  kill-session) for f in "$D/$S"/*.pid; do [ -e "$f" ] && stop "$(basename "$f" .pid)"; done; rm -rf "${D:?}/$S" ;;
  *) echo "stand-in tmux: $sub is not supported" >&2; exit 2 ;;
esac
SH
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH" FAKE_TMUX="$WORK/tmux"
export APRSCACHING_DATA="$WORK/d" APRSCACHING_DIR="$ROOT" APRSCACHING_SESSION=acs-upgrade APRSCACHING_START_WAIT=20
DATA="$APRSCACHING_DATA"
RUN="$DATA/run"
cleanup() {
  tmux kill-session -t "=$APRSCACHING_SESSION" 2>/dev/null || true
  kill "${SQUATTER:-}" "${SUP:-}" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

SECRET=deadbeefsecret
mkdir -p "$RUN"
chmod 700 "$DATA" "$RUN"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
# A station installed by an earlier release: no GATEWAY_SOCKET, a USB TNC on loopback.
printf '%s\n' "PORT=$PORT" "OPERATOR_SECRET=$SECRET" USB_KISS_DEVICE=/dev/bus/usb/001/002 KISS_TNC_HOST=127.0.0.1 \
  KISS_TNC_PORT=8001 >"$DATA/.env"
chmod 600 "$DATA/.env"

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
node "$WORK/listen.mjs" "$PORT" "$WORK/log" &
SQUATTER=$!

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
bash "$WORK/sup/supervise.sh" "$DATA/.env" "$WORK/listen.mjs" "$WORK/log" "$RUN/gateway.state" &
SUP=$!

# ---- the helper windows, running an earlier release's scripts -----------------------------------------
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
for w in notify alerts usb-kiss; do cp "$WORK/scripts/old-helper.sh" "$WORK/scripts/$w.sh"; done
tmux new-session -d -s "$APRSCACHING_SESSION" -n gateway "sleep 600"
for w in notify alerts usb-kiss; do tmux new-window -d -t "=$APRSCACHING_SESSION:" -n "$w" "bash $WORK/scripts/$w.sh"; done
tmux new-window -d -t "=$APRSCACHING_SESSION:" -n shell "sleep 600"

sleep 1.5
before="$(grep -c "^tcp .* $SECRET\$" "$WORK/log" || true)"
if [ "$before" -gt 0 ]; then pass "before the update the earlier helpers send the secret to TCP ($before requests)"; else
  fail "the earlier helpers sent nothing before the update: the check after it would prove nothing"
fi
declare -A oldpid
for w in notify alerts usb-kiss shell; do oldpid[$w]="$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/$w.pid")"; done

# ---- the update: git replaces the scripts, then install.sh's step on the .env ------------------------
for w in notify alerts usb-kiss; do cp "$WORK/scripts/new-helper.sh" "$WORK/scripts/$w.sh"; done
# The step as install.sh runs it, in a subshell with lib.sh (checked below that install.sh does).
(
  # shellcheck source=deploy/pocket/lib.sh
  . "$POCKET/lib.sh"
  pocket_sockets_env
  [ "$POCKET_ENV_MOVED" -eq 0 ] || pocket_restart_on_sockets
) >"$WORK/move.log" 2>&1 || fail "the move failed: $(cat "$WORK/move.log")"
: >"$WORK/log"
sleep 2

leaked="$(grep "^tcp " "$WORK/log" | grep -v -- ' -$' || true)"
if [ -z "$leaked" ]; then pass "after the update no helper sends the secret to the TCP port"; else
  fail "after the update the TCP port still received the secret:"
  sed 's/^/       /' <<<"$leaked"
fi
on_socket="$(grep -c "^socket /api/admin/station-status $SECRET\$" "$WORK/log" || true)"
if [ "$on_socket" -gt 0 ]; then pass "the respawned helpers reach the gateway on its socket ($on_socket requests)"; else
  fail "the gateway's socket saw no helper after the update: $(cat "$WORK/move.log")"
fi
for w in notify alerts usb-kiss; do
  if [ "$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/$w.pid")" != "${oldpid[$w]}" ]; then pass "the $w window was respawned"; else
    fail "the $w window runs the loop it started with"
  fi
done
if [ "$(cat "$FAKE_TMUX/$APRSCACHING_SESSION/shell.pid")" = "${oldpid[shell]}" ]; then pass "  … and the shell window was left alone"; else
  fail "the shell window was respawned"
fi
# install.sh runs the move and the restart before the gateway's first start, after the .env is written or kept.
if awk '/^# ---- 10\./{exit} /^step "Writing \$ENV_FILE"/{w=1} w && /pocket_restart_on_sockets$/{found=1} END{exit !found}' \
  "$POCKET/install.sh"; then
  pass "install.sh restarts a moved station onto the sockets"
else fail "install.sh does not run pocket_restart_on_sockets after the move"; fi

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed" >&2
  exit 1
fi
echo "all upgrade-socket checks passed"
