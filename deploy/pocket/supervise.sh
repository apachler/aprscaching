#!/usr/bin/env bash
# Keep one Pocket process running: start.sh runs it in the tmux windows `gateway` and `ingest`.
#
#   supervise.sh gateway      # servers/node, the gateway (SQLite)
#   supervise.sh ingest       # apps/ingest, waits for the gateway's /health first
#
# It loads ~/.aprscaching/.env before every start, so an edited .env takes effect on the next restart.
# The process restarts whenever it exits, like the systemd units (Restart=always, RestartSec=5): after
# 5 s, doubling on each quick failure up to 30 s, and back to 5 s once a run lasted a minute. Its output
# goes to the window and, with a timestamp, to ~/.aprscaching/logs/<name>.log, which is rotated by size
# (APRSCACHING_LOG_MAX_KB, default 1024; APRSCACHING_LOG_KEEP older files, default 3) so a phone does not
# fill up. The state (PIDs, restart count, start time) is in ~/.aprscaching/run/<name>.state for
# status.sh.
#
# Signals: TERM, INT or HUP stop the process (TERM, then KILL after 10 s) and end the supervisor;
# USR1 restarts the process at once (update.sh).
#
# Options:
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    gateway | ingest) NAME="$1" ;;
    *) echo "unknown argument: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$NAME" ] || { pocket_usage "$0" >&2; exit 2; }
pocket_paths

case "$NAME" in
  gateway) WORKDIR="$DIR/servers/node" ENTRY="$DIR/servers/node/src/server.ts" ;;
  ingest) WORKDIR="$DIR/apps/ingest" ENTRY="$DIR/apps/ingest/src/index.ts" ;;
esac

BASE_DELAY=5
MAX_DELAY=30
STABLE_AFTER=60
KILL_AFTER=10
LOG="$LOG_DIR/$NAME.log"
LOG_MAX_BYTES=$((${APRSCACHING_LOG_MAX_KB:-1024} * 1024))
LOG_KEEP="${APRSCACHING_LOG_KEEP:-3}"
STATE="$(state_file "$NAME")"

mkdir -p "$LOG_DIR" "$RUN_DIR"
chmod 700 "$RUN_DIR" 2>/dev/null || true

# <name>.log → .1 → … → .$LOG_KEEP; the oldest falls off.
rotate() {
  local i
  if [ "$LOG_KEEP" -le 0 ]; then
    : >"$LOG"
    return
  fi
  for ((i = LOG_KEEP - 1; i >= 1; i--)); do
    if [ -f "$LOG.$i" ]; then mv -f "$LOG.$i" "$LOG.$((i + 1))"; fi
  done
  if [ -f "$LOG" ]; then mv -f "$LOG" "$LOG.1"; fi
}
log_size() { if [ -f "$LOG" ]; then wc -c <"$LOG" | tr -d ' '; else echo 0; fi; }
rotate_if_big() { if [ "$(log_size)" -ge "$LOG_MAX_BYTES" ]; then rotate; fi; }

# One line from the supervisor, to the window and the log.
say() {
  printf '[supervise %s] %s\n' "$NAME" "$*"
  printf '%(%Y-%m-%d %H:%M:%S)T [supervise %s] %s\n' -1 "$NAME" "$*" >>"$LOG"
}

# The process's output: to the window as it is, to the log with a timestamp. The size is checked every
# 100 lines, so the log overshoots its limit by at most those lines.
logpipe() {
  local line n=0
  exec 3>>"$LOG"
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%(%Y-%m-%d %H:%M:%S)T %s\n' -1 "$line" >&3
    printf '%s\n' "$line" 2>/dev/null || true
    n=$((n + 1))
    if [ $((n % 100)) -eq 0 ] && [ "$(log_size)" -ge "$LOG_MAX_BYTES" ]; then
      exec 3>&-
      rotate
      exec 3>>"$LOG"
    fi
  done
}

SINCE="$(date +%s)"
restarts=0
child=""
started=""
last_exit=""
last_exit_at=""
next_start=""
write_state() {
  local tmp="$STATE.tmp.$$"
  {
    printf 'supervisor=%s\n' "$$"
    printf 'pid=%s\n' "$child"
    printf 'restarts=%s\n' "$restarts"
    printf 'since=%s\n' "$SINCE"
    printf 'started=%s\n' "$started"
    printf 'last_exit=%s\n' "$last_exit"
    printf 'last_exit_at=%s\n' "$last_exit_at"
    printf 'next_start=%s\n' "$next_start"
  } >"$tmp"
  mv -f "$tmp" "$STATE"
}

stopping=0
restart_now=0
sleeper=""
on_stop() {
  stopping=1
  if alive "$child"; then
    kill -TERM "$child" 2>/dev/null || true
    # A process that ignores TERM is killed once the grace period is over.
    (
      sleep "$KILL_AFTER"
      kill -KILL "$child" 2>/dev/null || true
    ) &
  fi
  if alive "$sleeper"; then kill "$sleeper" 2>/dev/null || true; fi
}
on_restart() {
  restart_now=1
  if alive "$child"; then kill -TERM "$child" 2>/dev/null || true; fi
  if alive "$sleeper"; then kill "$sleeper" 2>/dev/null || true; fi
}
trap on_stop TERM INT HUP
trap on_restart USR1
trap 'rm -f "$STATE.tmp.$$"' EXIT

# Sleep that a signal interrupts.
pause() {
  sleep "$1" &
  sleeper=$!
  wait "$sleeper" 2>/dev/null || true
  sleeper=""
}

# The ingest posts to the gateway; give a gateway that is still starting up to a minute.
wait_for_gateway() {
  local base i
  base="$(gateway_base)"
  for ((i = 0; i < 60; i++)); do
    health_ok "$base" 2 && return 0
    [ "$stopping" -eq 0 ] || return 0
    [ "$i" -eq 0 ] && say "waiting for the gateway on $base"
    pause 1
  done
  say "the gateway on $base does not answer; starting anyway"
}

rotate_if_big
say "supervising $ENTRY (log: $LOG)"
delay=$BASE_DELAY
while [ "$stopping" -eq 0 ]; do
  if [ "$NAME" = ingest ]; then wait_for_gateway; fi
  [ "$stopping" -eq 0 ] || break
  rotate_if_big
  started="$(date +%s)"
  next_start=""
  (
    env_load
    cd "$WORKDIR"
    exec node --import tsx "$ENTRY"
  ) > >(logpipe) 2>&1 &
  child=$!
  write_state
  say "started (pid $child)"

  # wait returns early when a trapped signal arrives; keep waiting until the process is gone.
  status=0
  while :; do
    status=0
    wait "$child" || status=$?
    alive "$child" || break
  done
  ran=$(($(date +%s) - started))
  child=""
  last_exit="$status"
  last_exit_at="$(date +%s)"

  if [ "$stopping" -eq 1 ]; then
    say "stopped (status $status)"
    break
  fi
  restarts=$((restarts + 1))
  if [ "$restart_now" -eq 1 ]; then
    restart_now=0
    delay=$BASE_DELAY
    write_state
    say "restarting on request"
    continue
  fi
  if [ "$ran" -ge "$STABLE_AFTER" ]; then delay=$BASE_DELAY; fi
  next_start=$(($(date +%s) + delay))
  write_state
  say "exited with status $status after ${ran}s; restart $restarts in ${delay}s"
  pause "$delay"
  restart_now=0
  delay=$((delay * 2))
  if [ "$delay" -gt "$MAX_DELAY" ]; then delay=$MAX_DELAY; fi
done
next_start=""
write_state
