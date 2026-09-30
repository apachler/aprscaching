#!/usr/bin/env bash
# Optional Termux add-ons for the station: home-screen shortcuts (Termux:Widget) and a daily backup while
# the phone charges (Termux:API's job scheduler). Each works only with its app installed from the same
# source as Termux (F-Droid, or all from GitHub: the apps share a signing key and refuse to talk to apps
# from another source); without it the script says what to install and leaves the rest as it is.
#
#   bash ~/aprscaching/deploy/pocket/extras/setup.sh                      # asks for each add-on
#   bash ~/aprscaching/deploy/pocket/extras/setup.sh --shortcuts --scheduled-backup
#   bash ~/aprscaching/deploy/pocket/extras/setup.sh --remove
#
# Shortcuts, in ~/.shortcuts/ (Termux:Widget lists them; add its widget to the home screen):
#   aprscaching Status     opens a terminal with status.sh (and a toast of the headline)
#   tasks/: aprscaching Start, Stop, Open map, Backup, Sync before trip — run in the background, report
#           with a toast
#
# Options:
#   --shortcuts          install the home-screen shortcuts
#   --scheduled-backup   register the daily backup (while charging, battery above 50 %)
#   --remove             remove the shortcuts and cancel the scheduled backup
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

SHORTCUTS=""
SCHEDULE=""
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shortcuts) SHORTCUTS=1 ;;
    --scheduled-backup) SCHEDULE=1 ;;
    --remove) REMOVE=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

SC_DIR="${APRSCACHING_SHORTCUTS_DIR:-$HOME/.shortcuts}"
JOB_ID=4287
NAMES=("aprscaching Status" "tasks/aprscaching Start" "tasks/aprscaching Stop" "tasks/aprscaching Open map"
  "tasks/aprscaching Backup" "tasks/aprscaching Sync before trip")

cancel_job() { if have termux-job-scheduler; then termux_api termux-job-scheduler --cancel --job-id "$JOB_ID" >/dev/null || true; fi; }

if [ "$REMOVE" -eq 1 ]; then
  step "Removing the add-ons"
  for n in "${NAMES[@]}"; do rm -f "$SC_DIR/$n"; done
  info "shortcuts removed from $SC_DIR"
  cancel_job
  rm -f "$RUN_DIR/scheduled-backup-job.sh"
  info "scheduled backup cancelled"
  exit 0
fi

# Ask on a terminal for anything not given as an option; without one, do only what the options say.
yes_no() {
  local answer
  if [ -t 0 ]; then
    read -r -p "    $1 [Y/n] " answer
    case "$answer" in n | N | no) return 1 ;; *) return 0 ;; esac
  fi
  return 1
}
if [ -z "$SHORTCUTS" ] && [ -z "$SCHEDULE" ]; then
  if yes_no "Install home-screen shortcuts (Termux:Widget)?"; then SHORTCUTS=1; fi
  if yes_no "Back up daily while charging (Termux:API job scheduler)?"; then SCHEDULE=1; fi
fi

q() { printf '%q' "$1"; }
ENVS="export APRSCACHING_DIR=$(q "$DIR") APRSCACHING_DATA=$(q "$DATA")"
toast_cmd() { printf 'if command -v termux-toast >/dev/null; then timeout 8 termux-toast -s %s; fi' "$1"; }

write_shortcut() {
  local name=$1 body=$2 file="$SC_DIR/$1"
  mkdir -p "$(dirname "$file")"
  printf '#!/data/data/com.termux/files/usr/bin/bash\n# aprscaching shortcut: %s\n%s\n%s\n' "${name##*/}" "$ENVS" "$body" >"$file"
  chmod 700 "$file"
}

if [ "${SHORTCUTS:-0}" = 1 ]; then
  step "Home-screen shortcuts in $SC_DIR"
  write_shortcut "aprscaching Status" "out=\"\$(bash $(q "$HERE/status.sh") 2>&1)\"
printf '%s\\n' \"\$out\"
if command -v termux-toast >/dev/null; then
  printf '%s\\n' \"\$out\" | grep -m1 -E '^ +gateway ' | sed 's/^ *//' | timeout 8 termux-toast -s
fi
read -r -p 'Enter closes this window. ' _"
  write_shortcut "tasks/aprscaching Start" "if bash $(q "$HERE/start.sh") --no-attach >/dev/null 2>&1; then $(toast_cmd "'aprscaching started'"); else $(toast_cmd "'aprscaching did not start: run status.sh'"); fi"
  write_shortcut "tasks/aprscaching Stop" "bash $(q "$HERE/stop.sh") >/dev/null 2>&1; $(toast_cmd "'aprscaching stopped'")"
  write_shortcut "tasks/aprscaching Open map" "termux-open-url http://localhost:$(gateway_port)"
  write_shortcut "tasks/aprscaching Backup" "if bash $(q "$HERE/backup.sh") >/dev/null 2>&1; then date +%s > $(q "$RUN_DIR/last-backup"); $(toast_cmd "'aprscaching backup done'"); else $(toast_cmd "'aprscaching backup failed: run backup.sh in Termux'"); fi"
  # The sync reports through its own notification; the toast covers a phone without one.
  write_shortcut "tasks/aprscaching Sync before trip" "if bash $(q "$HERE/extras/sync-now.sh") >/dev/null 2>&1; then $(toast_cmd "'aprscaching synced'"); else $(toast_cmd "'aprscaching sync failed or not on Wi-Fi: run extras/sync-now.sh in Termux'"); fi"
  info "Status, Start, Stop, Open map, Backup, Sync before trip. Add the Termux:Widget widget to the home"
  info "screen to use them."
  have termux-toast || termux_api_hint "toasts from the shortcuts"
fi

if [ "${SCHEDULE:-0}" = 1 ]; then
  step "Daily backup while charging"
  if ! have termux-job-scheduler || ! termux_api_ready; then
    termux_api_hint "the scheduled backup"
  else
    mkdir -p "$RUN_DIR"
    job="$RUN_DIR/scheduled-backup-job.sh"
    printf '#!/data/data/com.termux/files/usr/bin/bash\n%s\nexec bash %s\n' "$ENVS" \
      "$(q "$HERE/extras/scheduled-backup.sh")" >"$job"
    chmod 700 "$job"
    cancel_job
    termux_api termux-job-scheduler --job-id "$JOB_ID" --script "$job" --period-ms 86400000 \
      --charging true --battery-not-low true --persisted true >/dev/null
    info "registered: once a day while charging, when the battery is above 50 %; status.sh shows the last run"
    [ -d "$HOME/storage/shared" ] || info "run termux-setup-storage once, so the backup can write to shared storage"
  fi
fi
[ "${SHORTCUTS:-0}" = 1 ] || [ "${SCHEDULE:-0}" = 1 ] || info "nothing chosen; run again with --shortcuts or --scheduled-backup"
