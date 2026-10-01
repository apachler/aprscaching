#!/usr/bin/env bash
set -euo pipefail
# Publish the Cloudflare split from this checkout: apply D1 migrations, deploy the Worker stamped with its
# source commit, build the SPA against the Worker's URL and deploy it to Pages. deploy-cf.sh runs it after
# creating the resources and secrets; deploy/aprscaching update runs it for a new version.
# API_BASE = the public URL the deployed Worker answers on (workers.dev or your custom domain) — it is
# baked into the SPA build as VITE_API_BASE, so the Pages site talks to YOUR gateway.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_BASE="${API_BASE:?set API_BASE to the public URL of the Worker}"
cd "$ROOT/workers/gateway"
wrangler d1 migrations apply aprscaching --remote
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
wrangler deploy --var SOURCE_COMMIT:"$SOURCE_COMMIT" --var SOURCE_BUILT_AT:"$(date +%s)" --var SOURCE_REPO:"${SOURCE_REPO:-https://github.com/apachler/aprscaching}"
# Build the SPA against the deployed gateway before publishing it — a stale/missing dist (it is
# gitignored) or a localhost VITE_API_BASE would ship a Pages site that talks to nothing.
( cd "$ROOT" && VITE_API_BASE="$API_BASE" pnpm --filter @aprscaching/web build )
# Pages serves only the SPA; paths the gateway serves (crawler files, feeds, legal and source pages) would
# otherwise fall back to index.html on the app host, so send them to the gateway's host.
API="${API_BASE%/}"
cat > "$ROOT/apps/web/dist/_redirects" <<REDIRECTS
/robots.txt       $API/robots.txt 301
/sitemap.xml      $API/sitemap.xml 301
/sitemap          $API/sitemap 301
/feeds/*          $API/feeds/:splat 301
/embed            $API/embed 302
/embed/*          $API/embed/:splat 302
/imprint          $API/imprint 302
/privacy          $API/privacy 302
/support          $API/support 302
/source           $API/source 302
/.well-known/*    $API/.well-known/:splat 302
REDIRECTS
cd "$ROOT" && wrangler pages deploy apps/web/dist --project-name aprscaching
