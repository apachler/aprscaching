# Self-host: the Docker stack in deploy/ (gateway, ingest and Caddy, optionally a Cloudflare Tunnel), its
# settings in deploy/.env. Sourced by deploy/aprscaching, which provides the libraries.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

: "${SHAPE_ENV:=$DEPLOY_DIR/.env}"

# The compose files of this installation: the tunnel overlay when a tunnel token is set.
selfhost_compose() {
  local files=(-f "$DEPLOY_DIR/docker-compose.yml")
  [ -n "$(env_file_get "$SHAPE_ENV" TUNNEL_TOKEN)" ] && files+=(-f "$DEPLOY_DIR/compose.home.yml")
  # the commit the image is built from, for its source link; one set in .env (a fork's) wins
  [ -n "$(env_file_get "$SHAPE_ENV" SOURCE_COMMIT)" ] ||
    SOURCE_COMMIT="$(git -C "$DEPLOY_DIR/.." rev-parse HEAD 2>/dev/null || true)"
  SOURCE_COMMIT="${SOURCE_COMMIT:-}" docker compose --project-directory "$DEPLOY_DIR" "${files[@]}" "$@"
}

# init selfhost: setup.sh asks the questions and writes deploy/.env; its options pass through
# (deploy/aprscaching init selfhost --help lists them).
# --net44-config FILE also brings a 44Net Connect tunnel up afterwards (deploy/aprscaching net44 setup).
shape_init() {
  local opts=() setup=() net44=""
  [ "$APRS_INTERACTIVE" = 1 ] || opts+=(--non-interactive)
  [ "$APRS_ASSUME_YES" = 1 ] && opts+=(--yes)
  case " $* " in *" -h "* | *" --help "*) "$DEPLOY_DIR/setup.sh" --help; echo "  --net44-config FILE (bring a 44Net Connect tunnel up afterwards: deploy/aprscaching net44 setup)"; return 0 ;; esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --net44-config) net44="$2"; shift ;;
      *) setup+=("$1") ;;
    esac
    shift
  done
  "$DEPLOY_DIR/setup.sh" "${opts[@]+"${opts[@]}"}" "${setup[@]+"${setup[@]}"}"
  env_file_secure "$SHAPE_ENV"
  shape_record selfhost "$SHAPE_ENV"
  n44_init_offer "$net44"
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
    warnc service.meshcom_port "MeshCom's 1799/udp is published on every address of a public host" "publish it on the LAN address only"
  fi
  size="$(selfhost_compose exec -T gateway sh -c 'du -k "${DB_PATH:-/data/aprscaching.db}" | cut -f1' 2>/dev/null || true)"
  [ -z "$size" ] || pass resources.database "the database is $((size / 1024)) MiB"
}

# ---- backup and restore (deploy/lib/backup.sh) — through one-off containers on the data volume, so they
# work whether the gateway runs or not.
selfhost_run() { selfhost_compose run --rm --no-deps -T "$@"; }

shape_db_dump() { selfhost_run gateway node tools/backup/db.mjs dump /data/aprscaching.db; }

shape_db_restore() {
  # the new database is built beside the old one, which is kept as before-restore-<time>-*
  selfhost_run gateway sh -c 'set -e
    rm -f /data/restore.db
    node tools/backup/db.mjs restore /data/restore.db db/migrations "$0" $1 >&2
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    for f in aprscaching.db aprscaching.db-wal aprscaching.db-shm; do
      if [ -e "/data/$f" ]; then mv "/data/$f" "/data/before-restore-$ts-$f"; fi
    done
    mv /data/restore.db /data/aprscaching.db' "$2" "${3:+--exact}" <"$1"
}

shape_secrets_dump() {
  selfhost_run gateway sh -c 'cd /data && set -- *.secret && if [ -e "$1" ]; then tar -cf - "$@"; else tar -cf - -T /dev/null; fi' |
    tar -xf - -C "$1"
}
shape_secrets_restore() { tar -cf - -C "$1" . | selfhost_run gateway sh -c 'cd /data && tar -xf - && chmod 600 ./*.secret'; }
shape_media_dump() { selfhost_run gateway sh -c 'mkdir -p /data/media && cd /data/media && tar -cf - .' | tar -xf - -C "$1"; }
shape_media_restore() { tar -cf - -C "$1" . | selfhost_run gateway sh -c 'mkdir -p /data/media && cd /data/media && tar -xf -'; }
shape_stop() { selfhost_compose stop gateway ingest; }
shape_start() { selfhost_compose up -d; }


# ---- update (deploy/lib/update.sh): this checkout, rebuilt and restarted by compose; the gateway applies
# new migrations when it starts.
shape_git() { git -C "$DEPLOY_DIR/.." "$@"; }
shape_update_apply() { selfhost_compose up -d --build; }
