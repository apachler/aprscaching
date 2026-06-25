#!/usr/bin/env bash
set -euo pipefail
# Topology 3: cache the static world at Cloudflare, bypass dynamic paths. Requires CF_API_TOKEN + CF_ZONE_ID.
: "${CF_API_TOKEN:?set CF_API_TOKEN}"; : "${CF_ZONE_ID:?set CF_ZONE_ID}"
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
  --data '{"rules":[
    {"expression":"starts_with(http.request.uri.path,\"/api\") or starts_with(http.request.uri.path,\"/auth\") or starts_with(http.request.uri.path,\"/ws\") or starts_with(http.request.uri.path,\"/ingest\") or starts_with(http.request.uri.path,\"/outbox\") or starts_with(http.request.uri.path,\"/federation\") or starts_with(http.request.uri.path,\"/.well-known\")","action":"set_cache_settings","action_parameters":{"cache":false}},
    {"expression":"ends_with(http.request.uri.path,\".pmtiles\") or ends_with(http.request.uri.path,\".js\") or ends_with(http.request.uri.path,\".css\") or ends_with(http.request.uri.path,\".woff2\") or http.request.uri.path eq \"/\"","action":"set_cache_settings","action_parameters":{"cache":true,"edge_ttl":{"mode":"override_origin","default":86400}}}
  ]}'
echo
