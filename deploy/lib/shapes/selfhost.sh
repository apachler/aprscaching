# Self-host: the Docker stack in deploy/ (gateway, ingest and Caddy, optionally a Cloudflare Tunnel), its
# settings in deploy/.env. Sourced by deploy/aprscaching, which provides the libraries.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

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
  if health="$(curl -fsS --max-time 5 "${url%/}/health" 2>/dev/null)"; then
    case "$health" in '{'*) ok=1 ;; *) health="" ;; esac
  fi
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

# doctor: the gateway through this host's Caddy — with the public name pinned to this host, so a DNS
# problem shows as a network failure, not as a dead gateway.
shape_doctor_context() {
  local domain
  DOC_ENV="$SHAPE_ENV"
  DOC_PUBLIC="$(env_file_get "$SHAPE_ENV" APP_URL)"
  domain="$(env_file_get "$SHAPE_ENV" DOMAIN)"
  case "${domain:-:80}" in
    :*) DOC_BASE="http://127.0.0.1" ;;
    *) DOC_BASE="https://$domain"; DOC_CURL_OPTS=(--resolve "$domain:443:127.0.0.1") ;;
  esac
  DOC_INGEST="$DOC_BASE/ingest"
  if have docker; then DOC_DATA_DIR="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"; fi
  DOC_BACKUP_SETTINGS=1
}

shape_doctor_extra() {
  local svc running size want="gateway ingest caddy"
  have docker || { failc service.docker "docker is not installed here" "install Docker, or use --shape"; return 0; }
  running="$(selfhost_compose ps --status running --format '{{.Service}}' 2>/dev/null || true)"
  [ -z "$(env_file_get "$SHAPE_ENV" TUNNEL_TOKEN)" ] || want="$want cloudflared"
  for svc in $want; do
    if grep -qx "$svc" <<<"$running"; then pass "service.$svc" "$svc is running"; else
      failc "service.$svc" "$svc is not running" "deploy/aprscaching status; docker compose logs $svc"
    fi
  done
  # `compose port` prints the host address of a published port (and "…:0" when there is none)
  if selfhost_compose port gateway 8080 2>/dev/null | grep -qE ':[1-9][0-9]*$'; then
    warnc service.gateway_port "the gateway's port 8080 is published on the host, bypassing Caddy" "remove the ports: entry of the gateway service"
  fi
  if doc_public && selfhost_compose port --protocol udp ingest 1799 2>/dev/null | grep -qE '^(0\.0\.0\.0|\[::\]):[1-9]'; then
    warnc service.meshcom_port "MeshCom's 1799/udp is published on every address of a public host" "publish it on the LAN address only" \
      "docs/operate/meshcom.md"
  fi
  size="$(selfhost_compose exec -T gateway sh -c 'du -k "${DB_PATH:-/data/aprscaching.db}" | cut -f1' 2>/dev/null || true)"
  [ -z "$size" ] || pass resources.database "the database is $((size / 1024)) MiB"
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
