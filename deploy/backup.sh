#!/usr/bin/env bash
set -euo pipefail
# Nightly SQLite snapshot -> object storage. Add to cron:  0 3 * * * /opt/aprscaching/deploy/backup.sh
DB="${DB_PATH:-/opt/aprscaching/data/aprscaching.db}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="/tmp/aprscaching-${TS}.db"
sqlite3 "$DB" ".backup '$OUT'"; gzip "$OUT"
# Option A — OCI Object Storage (20GB always-free):
#   oci os object put -bn aprscaching-backups --file "${OUT}.gz" --name "db/${TS}.db.gz" --force
# Option B — Cloudflare R2 (aws cli with R2 endpoint):
#   aws s3 cp "${OUT}.gz" s3://aprscaching-backups/db/${TS}.db.gz --endpoint-url "$R2_ENDPOINT"
echo "backup staged at ${OUT}.gz (configure an upload option above)"
