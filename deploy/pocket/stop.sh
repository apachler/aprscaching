#!/usr/bin/env bash
# Stop the Pocket station: the ingest, then the gateway (SIGTERM, which lets the gateway checkpoint
# SQLite; SIGKILL after a grace period), then the tmux session `aprscaching`, and release the wake lock.
# Safe to run when nothing is running.
#
#   bash ~/aprscaching/deploy/pocket/stop.sh
#
# Options:
#   --grace N            seconds to wait after SIGTERM before SIGKILL (default 15)
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

GRACE=15
# --dir is accepted like in the other scripts, though this one does not use the checkout.
# shellcheck disable=SC2034
while [ $# -gt 0 ]; do
  case "$1" in
    --grace) GRACE="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
case "$GRACE" in '' | *[!0-9]*) die "--grace takes a number of seconds (got '$GRACE')." ;; esac

stop_proc() {
  local name=$1 sup pid i
  sup="$(state_get "$name" supervisor)"
  pid="$(state_get "$name" pid)"
  is_ours "$sup" "supervise.sh" || sup=""
  is_ours "$pid" "$(proc_entry "$name")" || pid=""
  if [ -z "$sup" ] && [ -z "$pid" ]; then
    info "$name: not running"
    return 0
  fi
  # The supervisor forwards SIGTERM to the process and exits once it is gone.
  if [ -n "$sup" ]; then kill -TERM "$sup" 2>/dev/null || true; fi
  if [ -z "$sup" ] && [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  for ((i = 0; i < GRACE * 5; i++)); do
    alive "$sup" || alive "$pid" || break
    sleep 0.2
  done
  if alive "$pid" || alive "$sup"; then
    warn "$name did not stop within ${GRACE}s; killing it"
    if alive "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
    if alive "$sup"; then kill -KILL "$sup" 2>/dev/null || true; fi
  fi
  info "$name: stopped"
}

step "Stopping the station"
stop_proc ingest
stop_proc gateway
if have termux-wake-unlock; then
  termux-wake-unlock || true
  info "wake lock released"
fi
# Last: run from the session's own shell window, closing the session ends this script too.
if session_exists; then
  info "closing tmux session $SESSION"
  tmux kill-session -t "=$SESSION"
else
  info "tmux session $SESSION: not running"
fi
