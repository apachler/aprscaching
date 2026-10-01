# Pocket: the gateway and the ingest on an Android phone in Termux, run by the scripts in deploy/pocket/,
# its settings in ~/.aprscaching/.env. Each command hands over to the Pocket script that does it, so the
# Pocket scripts stay the one implementation. Sourced by deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

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

# doctor: the station on this phone; its backups in shared storage.
shape_doctor_context() {
  local data port
  data="$(dirname "$SHAPE_ENV")"
  port="$(env_file_get "$SHAPE_ENV" PORT)"
  DOC_ENV="$SHAPE_ENV"
  DOC_BASE="http://127.0.0.1:${port:-8787}"
  DOC_PUBLIC="$(env_file_get "$SHAPE_ENV" APP_URL)"
  DOC_INGEST="$(env_file_get "$SHAPE_ENV" INGEST_URL)"
  DOC_INGEST="${DOC_INGEST:-$DOC_BASE/ingest}"
  DOC_DATA_DIR="$data"
  DOC_DB_FILE="$(env_file_get "$SHAPE_ENV" DB_PATH)"
  DOC_DB_FILE="${DOC_DB_FILE:-$data/aprscaching.db}"
  DOC_BACKUP_DIR="${APRSCACHING_BACKUP_DIR:-$HOME/storage/shared/aprscaching-backups}"
  DOC_BACKUP_GLOB="aprscaching-pocket-*.tar.gz"
}
