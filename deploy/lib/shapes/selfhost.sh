# Self-host: the Docker stack in deploy/ (gateway, ingest and Caddy, optionally a Cloudflare Tunnel), its
# settings in deploy/.env. Sourced by deploy/aprscaching, which provides the libraries.
# shellcheck shell=bash

: "${SHAPE_ENV:=$DEPLOY_DIR/.env}"

# The compose files of this installation: the tunnel overlay when a tunnel token is set.
selfhost_compose() {
  local files=(-f "$DEPLOY_DIR/docker-compose.yml")
  [ -n "$(env_file_get "$SHAPE_ENV" TUNNEL_TOKEN)" ] && files+=(-f "$DEPLOY_DIR/compose.home.yml")
  docker compose --project-directory "$DEPLOY_DIR" "${files[@]}" "$@"
}

# init selfhost: setup.sh asks the questions and writes deploy/.env; its options pass through
# (deploy/aprscaching init selfhost --help lists them).
shape_init() {
  local opts=()
  [ "$APRS_INTERACTIVE" = 1 ] || opts+=(--non-interactive)
  [ "$APRS_ASSUME_YES" = 1 ] && opts+=(--yes)
  case " $* " in *" -h "* | *" --help "*) exec "$DEPLOY_DIR/setup.sh" --help ;; esac
  "$DEPLOY_DIR/setup.sh" "${opts[@]+"${opts[@]}"}" "$@"
  env_file_secure "$SHAPE_ENV"
  shape_record selfhost "$SHAPE_ENV"
}

shape_status() {
  local url health="" ok=0 services=""
  url="$(env_file_get "$SHAPE_ENV" APP_URL)"
  url="${url:-http://localhost}"
  if health="$(curl -fsS --max-time 5 "${url%/}/health" 2>/dev/null)"; then ok=1; fi
  if have docker; then services="$(selfhost_compose ps --format '{{.Service}} {{.State}}' 2>/dev/null || true)"; fi
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"selfhost","url":%s,"healthy":%s,"health":%s,"services":%s}\n' \
      "$(json_str "$url")" "$([ "$ok" = 1 ] && echo true || echo false)" "${health:-null}" "$(json_str "$services")"
    return 0
  fi
  step "Self-host at $url"
  if [ "$ok" = 1 ]; then info "health: $health"; else info "health: no answer from ${url%/}/health"; fi
  if [ -n "$services" ]; then
    info "services:"
    while IFS= read -r line; do info "  $line"; done <<<"$services"
  elif ! have docker; then
    info "services: docker is not installed here"
  fi
}

# backup: deploy/backup.sh with this installation's settings (its destination comes from deploy/.env).
shape_backup() {
  [ -f "$SHAPE_ENV" ] || die "$SHAPE_ENV is missing." "Run deploy/aprscaching init selfhost first."
  (
    set -a
    # shellcheck disable=SC1090 # the operator's own .env
    . "$SHAPE_ENV"
    set +a
    exec "$DEPLOY_DIR/backup.sh" "$@"
  )
}
