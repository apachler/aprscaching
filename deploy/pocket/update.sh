#!/usr/bin/env bash
# Update the Pocket station: fetch the branch, install the dependencies, rebuild better-sqlite3 and the
# web app when needed (install.sh does all of it and keeps the .env), then restart the gateway and the
# ingest in the running tmux session. The gateway applies new database migrations when it starts.
# The station keeps running while the update builds; the restart takes a few seconds.
#
#   bash ~/aprscaching/deploy/pocket/update.sh
#   bash ~/aprscaching/deploy/pocket/update.sh --branch dev --pkg
#
# Options:
#   --branch NAME        branch to update to            (APRSCACHING_BRANCH, default the checked-out one)
#   --pkg                also upgrade the Termux packages (install.sh without --skip-pkg)
#   --no-restart         update only; restart later with stop.sh and start.sh
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
# Any other option is passed to install.sh (e.g. --build-sqlite, --allow-non-termux).
set -euo pipefail

# git replaces the files of this directory during the update, and bash reads a script as it runs it:
# run from a copy so the update never executes a half-old, half-new script.
if [ -z "${POCKET_UPDATE_HERE:-}" ]; then
  POCKET_UPDATE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  copy="$(mktemp "${TMPDIR:-/tmp}/aprscaching-update.XXXXXX")"
  cp "$0" "$copy"
  POCKET_UPDATE_HERE="$POCKET_UPDATE_HERE" POCKET_UPDATE_COPY="$copy" exec bash "$copy" "$@"
fi
HERE="$POCKET_UPDATE_HERE"
trap 'rm -f "${POCKET_UPDATE_COPY:-}"' EXIT
# lib.sh is read whole when sourced, before git touches it.
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

BRANCH="${APRSCACHING_BRANCH:-}"
PKG=0
RESTART=1
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift ;;
    --pkg) PKG=1 ;;
    --no-restart) RESTART=0 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$HERE/update.sh"; exit 0 ;;
    *) PASS+=("$1") ;;
  esac
  shift
done
pocket_paths

[ -d "$DIR/.git" ] || die "$DIR is not a git checkout." "Pass --dir PATH, or run install.sh first."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first."
if [ -z "$BRANCH" ]; then
  BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" != HEAD ] || die "$DIR is on a detached HEAD." "Pass --branch NAME."
fi

before="$(git -C "$DIR" rev-parse HEAD)"
scripts_sum() { cat "$DIR/deploy/pocket/supervise.sh" "$DIR/deploy/pocket/lib.sh" 2>/dev/null | cksum || true; }
sup_before="$(scripts_sum)"

# The same steps as the first install, from a copy of install.sh for the reason above.
args=(--dir "$DIR" --data-dir "$DATA" --branch "$BRANCH" --no-next-steps)
[ "$PKG" -eq 1 ] || args+=(--skip-pkg)
installer="$(mktemp "${TMPDIR:-/tmp}/aprscaching-install.XXXXXX")"
cp "$DIR/deploy/pocket/install.sh" "$installer"
status=0
bash "$installer" "${args[@]}" "${PASS[@]}" || status=$?
rm -f "$installer"
[ "$status" -eq 0 ] || die "install.sh failed (status $status); the station runs on as it was."

after="$(git -C "$DIR" rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  step "Already at $(git -C "$DIR" rev-parse --short HEAD)"
else
  step "Updated $(git -C "$DIR" rev-parse --short "$before") -> $(git -C "$DIR" rev-parse --short "$after")"
  # A newer install.sh may add steps; run it once more on the updated checkout without fetching.
  if ! git -C "$DIR" diff --quiet "$before" "$after" -- deploy/pocket/install.sh; then
    info "install.sh changed; running the new one"
    bash "$DIR/deploy/pocket/install.sh" "${args[@]}" --no-update "${PASS[@]}" ||
      die "the updated install.sh failed; the station runs on as it was."
  fi
fi

if [ "$RESTART" -eq 0 ]; then
  info "not restarting (--no-restart)"
  exit 0
fi

# Each supervisor restarts its process at once on USR1; new code and migrations load on that start.
step "Restarting the gateway and the ingest"
if ! restart_station; then
  info "the station is not running; start it with: bash $DIR/deploy/pocket/start.sh"
  exit 0
fi
BASE="$(gateway_base)"
sleep 2
for _ in $(seq 1 "${APRSCACHING_START_WAIT:-120}"); do
  if health_ok "$BASE" 2; then
    info "gateway healthy on $BASE"
    break
  fi
  sleep 1
done
health_ok "$BASE" 2 || warn "the gateway does not answer on $BASE yet; see $LOG_DIR/gateway.log"
if [ "$(scripts_sum)" != "$sup_before" ]; then
  info "the process scripts changed too: run stop.sh and start.sh (from Termux, not from the session's"
  info "shell window) to load them."
fi
