# Pocket: the gateway and the ingest on an Android phone in Termux, run by the scripts in deploy/pocket/,
# its settings in ~/.aprscaching/.env. Each command hands over to the Pocket script that does it, so the
# Pocket scripts stay the one implementation. Sourced by deploy/aprscaching.
# shellcheck shell=bash

: "${SHAPE_ENV:=${APRSCACHING_DATA:-$HOME/.aprscaching}/.env}"
POCKET_DIR="$DEPLOY_DIR/pocket"

shape_init() {
  bash "$POCKET_DIR/wizard.sh" "$@"
  shape_record pocket "$SHAPE_ENV"
}
shape_status() {
  [ "$APRS_JSON" = 1 ] && die "status --json is not available for the pocket shape." "Run it without --json."
  bash "$POCKET_DIR/status.sh" "$@"
}
shape_update() { bash "$POCKET_DIR/update.sh" "$@"; }
shape_backup() { bash "$POCKET_DIR/backup.sh" "$@"; }
shape_restore() { bash "$POCKET_DIR/backup.sh" --restore "$@"; }
