# Ingest box: only the ingest (deploy/compose.ingest-only.yml) on the operator's own equipment, posting to
# a gateway elsewhere; its settings in deploy/.env. Sourced by deploy/aprscaching.
# shellcheck shell=bash

: "${SHAPE_ENV:=$DEPLOY_DIR/.env}"

shape_status() {
  local gw services=""
  gw="$(env_file_get "$SHAPE_ENV" INGEST_URL)"
  if have docker; then
    services="$(docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.ingest-only.yml" \
      ps --format '{{.Service}} {{.State}}' 2>/dev/null || true)"
  fi
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"ingest-box","gateway":%s,"services":%s}\n' "$(json_str "$gw")" "$(json_str "$services")"
    return 0
  fi
  step "Ingest box posting to ${gw:-(INGEST_URL not set)}"
  if [ -n "$services" ]; then
    while IFS= read -r line; do info "$line"; done <<<"$services"
  else
    info "no ingest container is running here"
  fi
}
