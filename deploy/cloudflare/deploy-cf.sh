#!/usr/bin/env bash
set -euo pipefail
# Topology 4 one-shot: managed Cloudflare core (Worker + D1 + R2 + Pages). Requires wrangler + CF auth.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/workers/gateway"
wrangler d1 create aprscaching || true
echo ">> Paste the database_id into wrangler.toml, then press Enter."; read -r _
wrangler d1 migrations apply aprscaching --remote
wrangler r2 bucket create aprscaching-media || true
wrangler secret put INGEST_SECRET
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
wrangler deploy --var SOURCE_COMMIT:"$SOURCE_COMMIT" --var SOURCE_BUILT_AT:"$(date +%s)" --var SOURCE_REPO:"${SOURCE_REPO:-https://github.com/apachler/aprscaching}"
cd "$ROOT" && wrangler pages deploy apps/web/dist --project-name aprscaching
echo ">> Done. Run the operator RF ingest with INGEST_URL=https://<your-worker>/ingest (compose.ingest-only.yml)."
