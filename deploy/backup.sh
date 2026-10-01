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
#
# Retention: BACKUP_DIR snapshots older than BACKUP_RETENTION_DAYS (default 30) are deleted here.
# Bucket destinations are append-only by default — the script never deletes from them, so their key
# needs no delete permission and a compromised host cannot wipe its own backups. Expire bucket snapshots
# with a lifecycle rule on the bucket's `db/` prefix. Where a lifecycle rule is not available, setting
# BACKUP_PRUNE_BUCKET=1 makes the script delete bucket snapshots older than BACKUP_RETENTION_DAYS itself;
# the key then needs delete permission.
DB="${DB_PATH:-/opt/aprscaching/data/aprscaching.db}"
RETAIN="${BACKUP_RETENTION_DAYS:-30}"
PRUNE_BUCKET="${BACKUP_PRUNE_BUCKET:-0}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"; GZ="${STAGE}/aprscaching-${TS}.db.gz"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$DB" ] || { echo "backup: DB not found at $DB (set DB_PATH)"; exit 1; }
# .backup takes a consistent snapshot even while the gateway is writing; then compress.
sqlite3 "$DB" ".backup '${STAGE}/aprscaching-${TS}.db'"
gzip "${STAGE}/aprscaching-${TS}.db"
NAME="db/${TS}.db.gz"

case "$RETAIN" in ''|*[!0-9]*) echo "backup: BACKUP_RETENTION_DAYS must be a whole number of days" >&2; exit 1 ;; esac

# Snapshot keys older than the retention window, read from stdin. The age comes from the timestamp in the
# key name (listing mtimes change when objects are copied or restored), compared as a fixed-width string.
# Only names of the form db/YYYYMMDDTHHMMSSZ.db.gz match, and the snapshot just written is never listed.
expired_keys() {
  cutoff="$(date -u -d "-${RETAIN} days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"${RETAIN}"d +%Y%m%dT%H%M%SZ)"
  { grep -oE '[0-9]{8}T[0-9]{6}Z\.db\.gz' || true; } | sort -u | while read -r key; do
    stamp="${key%.db.gz}"
    if [[ "$stamp" != "$TS" && "$stamp" < "$cutoff" ]]; then echo "db/${key}"; fi
  done
}

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
  if [ "$PRUNE_BUCKET" = "1" ]; then
    oci os object list -bn "$OCI_BUCKET" --prefix db/ --all --query 'data[].name' --raw-output \
      | expired_keys | while read -r key; do
        oci os object delete -bn "$OCI_BUCKET" --object-name "$key" --force >/dev/null
        echo "backup: pruned oci://${OCI_BUCKET}/${key}"
      done
  fi
elif [ -n "${BACKUP_BUCKET:-}" ] && [ -n "${R2_ENDPOINT:-}" ]; then
  command -v aws >/dev/null || { echo "backup: BACKUP_BUCKET set but the 'aws' CLI is not installed"; exit 1; }
  aws s3 cp "$GZ" "s3://${BACKUP_BUCKET}/${NAME}" --endpoint-url "$R2_ENDPOINT" >/dev/null
  echo "backup: uploaded s3://${BACKUP_BUCKET}/${NAME} (via ${R2_ENDPOINT})"
  if [ "$PRUNE_BUCKET" = "1" ]; then
    aws s3 ls "s3://${BACKUP_BUCKET}/db/" --endpoint-url "$R2_ENDPOINT" \
      | expired_keys | while read -r key; do
        aws s3 rm "s3://${BACKUP_BUCKET}/${key}" --endpoint-url "$R2_ENDPOINT" >/dev/null
        echo "backup: pruned s3://${BACKUP_BUCKET}/${key}"
      done
  fi
else
  echo "backup: no destination configured — set BACKUP_DIR, OCI_BUCKET, or BACKUP_BUCKET+R2_ENDPOINT." >&2
  echo "backup: refusing to exit 0 on a no-op so cron does not mistake this for a successful backup." >&2
  exit 2
fi
