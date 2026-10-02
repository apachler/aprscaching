#!/usr/bin/env bash
set -euo pipefail
# Cloudflare split one-shot: managed Cloudflare core (Worker + D1 + R2 + Pages). Requires wrangler + CF auth.
# API_BASE = the public URL the deployed Worker answers on (workers.dev or your custom domain) —
# it is baked into the SPA build as VITE_API_BASE, so the Pages site talks to YOUR gateway.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_BASE="${API_BASE:-}"
if [ -z "$API_BASE" ]; then
  read -rp ">> Public gateway URL for the SPA (e.g. https://api.example.net or https://aprscaching.<you>.workers.dev): " API_BASE
fi
cd "$ROOT/workers/gateway"
wrangler d1 create aprscaching || true
echo ">> Paste the database_id into wrangler.toml, then press Enter."; read -r _
# the two R2 buckets wrangler.toml binds: TILES (the offline map's archive) and MEDIA (cache media and audio
# clues). A deploy fails while a bound bucket is missing; an existing bucket is left as it is.
wrangler r2 bucket create aprscaching-assets || true
wrangler r2 bucket create aprscaching-media || true
# three distinct secrets: the ingest box's, the operator's scripts', and the session-signing key
# (the Worker mints no session without SESSION_SECRET). Generate each with: openssl rand -hex 32
wrangler secret put INGEST_SECRET
wrangler secret put OPERATOR_SECRET
wrangler secret put SESSION_SECRET
API_BASE="$API_BASE" bash "$ROOT/deploy/cloudflare/publish.sh"
echo ">> Done. Run the operator RF ingest with INGEST_URL=${API_BASE}/ingest (compose.ingest-only.yml)."
