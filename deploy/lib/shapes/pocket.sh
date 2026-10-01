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
# Portable backups (deploy/lib/backup.sh), from this checkout with the station's settings. Pocket's own
# archives (pocket/backup.sh, the scheduled phone backup) restore through pocket/backup.sh.
pk_data() { dirname "$SHAPE_ENV"; }
pk_db() {
  local db
  db="$(env_file_get "$SHAPE_ENV" DB_PATH)"
  printf '%s' "${db:-$(pk_data)/aprscaching.db}"
}
pk_media() {
  local m
  m="$(env_file_get "$SHAPE_ENV" MEDIA_DIR)"
  printf '%s' "${m:-$(pk_data)/media}"
}
shape_db_dump() { node "$DEPLOY_DIR/../tools/backup/db.mjs" dump "$(pk_db)"; }
shape_db_restore() {
  local db ts f
  db="$(pk_db)"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rm -f "$db.restore"
  node "$DEPLOY_DIR/../tools/backup/db.mjs" restore "$db.restore" "$DEPLOY_DIR/../db/migrations" "$2" ${3:+--exact} <"$1" >&2
  for f in "$db" "$db-wal" "$db-shm"; do
    if [ -e "$f" ]; then mv "$f" "$(dirname "$f")/before-restore-$ts-$(basename "$f")"; fi
  done
  mv "$db.restore" "$db"
}
shape_secrets_dump() { (cd "$(pk_data)" && for f in *.secret; do if [ -e "$f" ]; then cp -p "$f" "$1/"; fi; done); }
shape_secrets_restore() { cp -p "$1"/*.secret "$(pk_data)/" && chmod 600 "$(pk_data)"/*.secret; }
shape_media_dump() { if [ -d "$(pk_media)" ]; then cp -a "$(pk_media)/." "$1/"; fi; }
shape_media_restore() { mkdir -p "$(pk_media)" && cp -a "$1/." "$(pk_media)/"; }
shape_stop() { bash "$POCKET_DIR/stop.sh" || true; }
shape_start() { bash "$POCKET_DIR/start.sh" --no-attach; }
shape_restore_pocket_archive() { bash "$POCKET_DIR/backup.sh" --restore "$1"; }

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
