#!/usr/bin/env bash
set -euo pipefail
# Self-host behind Cloudflare's CDN: cache the static world at Cloudflare, bypass dynamic paths. Requires CF_API_TOKEN + CF_ZONE_ID.
# Three rules: the gateway's dynamic paths bypass the cache; the build's content-hashed files (/assets/), fonts and
# map archives stay at the edge for a day; the HTML (/ and *.html), the service worker and the web manifest bypass
# it, so a new release reaches every visitor at once instead of an index that names assets the origin no longer has.
# An error answer under the day-long rule (a 404 for a file the origin does not have yet) is never stored at the
# edge: that rule's TTL overrides the origin's Cache-Control, and would otherwise keep the 404 for a day.
# Cloudflare answers a rejected ruleset with "success":false and changes nothing; the script then fails, after
# printing Cloudflare's answer.
: "${CF_API_TOKEN:?set CF_API_TOKEN}"; : "${CF_ZONE_ID:?set CF_ZONE_ID}"
answer="$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
  --data '{"rules":[
    {"expression":"starts_with(http.request.uri.path,\"/api\") or starts_with(http.request.uri.path,\"/auth\") or starts_with(http.request.uri.path,\"/ws\") or starts_with(http.request.uri.path,\"/ingest\") or starts_with(http.request.uri.path,\"/outbox\") or starts_with(http.request.uri.path,\"/federation\") or starts_with(http.request.uri.path,\"/.well-known\") or starts_with(http.request.uri.path,\"/source\")","action":"set_cache_settings","action_parameters":{"cache":false}},
    {"expression":"starts_with(http.request.uri.path,\"/assets/\") or ends_with(http.request.uri.path,\".pmtiles\") or ends_with(http.request.uri.path,\".woff2\")","action":"set_cache_settings","action_parameters":{"cache":true,"edge_ttl":{"mode":"override_origin","default":86400,"status_code_ttl":[{"status_code_range":{"from":400,"to":599},"value":-1}]}}},
    {"expression":"http.request.uri.path eq \"/\" or ends_with(http.request.uri.path,\".html\") or http.request.uri.path eq \"/sw.js\" or ends_with(http.request.uri.path,\".webmanifest\")","action":"set_cache_settings","action_parameters":{"cache":false}}
  ]}')"
printf '%s\n' "$answer"
grep -q '"success": *true' <<<"$answer" || { echo "Cloudflare did not accept the cache rules (its answer is above)" >&2; exit 1; }
