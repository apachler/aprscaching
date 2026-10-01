# Ingest box: only the ingest (deploy/compose.ingest-only.yml) on the operator's own equipment, posting to
# a gateway elsewhere; its settings in deploy/.env. Sourced by deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

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

# doctor: the box's link to its gateway and its transports.
shape_doctor_context() {
  DOC_ENV="$SHAPE_ENV"
  DOC_INGEST="$(env_file_get "$SHAPE_ENV" INGEST_URL)"
  [ -n "$DOC_INGEST" ] || failc config.ingest_url "INGEST_URL is not set" "set it to your gateway's /ingest URL in $SHAPE_ENV"
}

shape_doctor_extra() {
  have docker || return 0
  if docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.ingest-only.yml" ps --status running \
    --format '{{.Service}}' 2>/dev/null | grep -qx ingest; then
    pass service.ingest "the ingest is running"
  else
    failc service.ingest "the ingest is not running" "docker compose -f compose.ingest-only.yml up -d"
  fi
}
