#!/usr/bin/env bash
set -euo pipefail
# Nightly SQLite snapshot -> object storage. Add to cron:  0 3 * * * /opt/aprscaching/deploy/backup.sh
#
# A backup that only stages a file to /tmp is not a backup — /tmp is wiped and the snapshot is lost.
# So this script UPLOADS to whichever destination is configured and FAILS LOUDLY (non-zero exit, which
# cron surfaces) when none is, rather than silently pretending to have backed up. Configure exactly one:
#   BACKUP_DIR         local/mounted directory (simplest; use a mount that is NOT the DB's disk)
#   OCI_BUCKET         OCI Object Storage bucket (20 GB always-free); needs the `oci` CLI configured
#   BACKUP_BUCKET + R2_ENDPOINT   S3-compatible (Cloudflare R2 / AWS S3); needs the `aws` CLI configured
# BACKUP_RETENTION_DAYS (default 30) prunes older snapshots at the destination.
DB="${DB_PATH:-/opt/aprscaching/data/aprscaching.db}"
RETAIN="${BACKUP_RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"; GZ="${STAGE}/aprscaching-${TS}.db.gz"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$DB" ] || { echo "backup: DB not found at $DB (set DB_PATH)"; exit 1; }
# .backup takes a consistent snapshot even while the gateway is writing; then compress.
sqlite3 "$DB" ".backup '${STAGE}/aprscaching-${TS}.db'"
gzip "${STAGE}/aprscaching-${TS}.db"
NAME="db/${TS}.db.gz"

if [ -n "${BACKUP_DIR:-}" ]; then
  mkdir -p "$BACKUP_DIR"
  cp "$GZ" "${BACKUP_DIR}/${TS}.db.gz"
  # prune by mtime
  find "$BACKUP_DIR" -name '*.db.gz' -type f -mtime "+${RETAIN}" -delete 2>/dev/null || true
  echo "backup: wrote ${BACKUP_DIR}/${TS}.db.gz"
elif [ -n "${OCI_BUCKET:-}" ]; then
  command -v oci >/dev/null || { echo "backup: OCI_BUCKET set but the 'oci' CLI is not installed"; exit 1; }
  oci os object put -bn "$OCI_BUCKET" --file "$GZ" --name "$NAME" --force >/dev/null
  echo "backup: uploaded oci://${OCI_BUCKET}/${NAME}"
elif [ -n "${BACKUP_BUCKET:-}" ] && [ -n "${R2_ENDPOINT:-}" ]; then
  command -v aws >/dev/null || { echo "backup: BACKUP_BUCKET set but the 'aws' CLI is not installed"; exit 1; }
  aws s3 cp "$GZ" "s3://${BACKUP_BUCKET}/${NAME}" --endpoint-url "$R2_ENDPOINT" >/dev/null
  echo "backup: uploaded s3://${BACKUP_BUCKET}/${NAME} (via ${R2_ENDPOINT})"
else
  echo "backup: no destination configured — set BACKUP_DIR, OCI_BUCKET, or BACKUP_BUCKET+R2_ENDPOINT." >&2
  echo "backup: refusing to exit 0 on a no-op so cron does not mistake this for a successful backup." >&2
  exit 2
fi
