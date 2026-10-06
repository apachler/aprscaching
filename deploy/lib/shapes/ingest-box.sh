# Ingest box: only the ingest (deploy/compose.ingest-only.yml) on the operator's own equipment, posting to
# a gateway elsewhere; its settings in deploy/.env. Sourced by deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

: "${SHAPE_ENV:=$DEPLOY_DIR/.env}"

ib_compose() { docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.ingest-only.yml" "$@"; }

ib_usage() {
  cat <<'USAGE'
deploy/aprscaching init ingest-box [options]

Sets up this box to feed a gateway elsewhere: enrolls it with a one-time code from the gateway's Instance
admin -> Ingest boxes (or takes the gateway's shared INGEST_SECRET), sets its feeds and radios, writes
deploy/.env, starts the ingest container and runs doctor.

  --gateway URL        the gateway, e.g. https://aprs.example.net (its /ingest is used)
  --code CODE          the one-time enrollment code
  --shared-secret      use the gateway's INGEST_SECRET instead of enrolling (asked for, never shown;
                       non-interactive: from the INGEST_SECRET environment variable)
  --box ID             this box's id                        (default: box-<host name>)
  --label NAME         a name the sysop sees for this box
  --call CALL          your callsign, for the APRS-IS login
  --passcode N         APRS-IS passcode (default -1, receive-only)
  --filter FILTER      APRS-IS filter, e.g. r/47.07/15.42/300
  --kiss HOST[:PORT]   a KISS TNC over TCP (Direwolf, a TNC with a network port)
  --meshcom ADDR=CALL  a MeshCom node (its ExtUDP address and call)
  --site-call CALL     the receiving site this box's TNC names (RF_SITE_CALL)
  --no-start           write the settings only
USAGE
}

# Enroll with the code inside the ingest image (no Node.js needed on the box). Its stdout is BOX_ID and
# BOX_KEY, written straight into the settings: the private key never reaches the screen.
ib_enroll() {
  local url="$1" code="$2" box="$3" label="$4" out line
  info "building the ingest image (the first time takes a few minutes)"
  ib_compose build -q ingest >/dev/null
  out="$(ib_compose run --rm --no-deps -T -w /app/apps/ingest ingest \
    node --import tsx src/enroll.ts --url "$url" --code "$code" --box "$box" ${label:+--label "$label"})" ||
    die "Enrollment failed (the message above says why)." "Ask the sysop for a new code if this one is used or expired."
  while IFS= read -r line; do
    case "$line" in BOX_ID=* | BOX_KEY=*) env_file_set "$SHAPE_ENV" "${line%%=*}" "${line#*=}" ;; esac
  done <<<"$out"
  [ -n "$(env_file_get "$SHAPE_ENV" BOX_KEY)" ] || die "Enrollment returned no key."
}

shape_init() {
  local gateway="" code="" shared=0 box="" label="" call="" pass="" filter="" kiss="" meshcom="" site="" start=1
  local url status secret
  while [ $# -gt 0 ]; do
    case "$1" in
      --gateway) gateway="$2"; shift ;;
      --code) code="$2"; shift ;;
      --shared-secret) shared=1 ;;
      --box) box="$2"; shift ;;
      --label) label="$2"; shift ;;
      --call) call="$2"; shift ;;
      --passcode) pass="$2"; shift ;;
      --filter) filter="$2"; shift ;;
      --kiss) kiss="$2"; shift ;;
      --meshcom) meshcom="$2"; shift ;;
      --site-call) site="$2"; shift ;;
      --no-start) start=0 ;;
      -h | --help) ib_usage; return 0 ;;
      *) die "Unknown option $1." "deploy/aprscaching init ingest-box --help lists them." ;;
    esac
    shift
  done
  have docker || die "Docker is missing." "The ingest box runs in Docker: https://docs.docker.com/engine/install/"
  if [ -f "$SHAPE_ENV" ] && grep -qE '^(OPERATOR_SECRET|ADMIN_CALLSIGNS)=.' "$SHAPE_ENV"; then
    die "$SHAPE_ENV belongs to a gateway on this host." \
      "An ingest box feeds a gateway elsewhere; the Self-host stack runs its own ingest already."
  fi

  step "Gateway"
  ask gateway "The gateway's address (e.g. https://aprs.example.net)" \
    "${gateway:-$(env_file_get "$SHAPE_ENV" INGEST_URL | sed 's|/ingest$||')}" --gateway
  url="${gateway%/}"
  url="${url%/ingest}/ingest"
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/check" 2>/dev/null || true)"
  case "$status" in
    401 | 200) info "the gateway answers at $url" ;;
    404) die "$url/check is not there." "The address is not an aprscaching gateway." ;;
    *) die "The gateway does not answer at $url." "Check the address and this box's network." ;;
  esac
  env_file_secure "$SHAPE_ENV"
  env_file_set "$SHAPE_ENV" INGEST_URL "$url"

  step "Credentials"
  if [ -n "$(env_file_get "$SHAPE_ENV" BOX_KEY)" ] && [ -z "$code" ] && [ "$shared" = 0 ]; then
    info "kept the enrolled key of box $(env_file_get "$SHAPE_ENV" BOX_ID)"
  elif [ "$shared" = 1 ]; then
    secret="${INGEST_SECRET:-}"
    [ -n "$secret" ] || ask_secret secret "The gateway's INGEST_SECRET (not shown)" --shared-secret
    [ -n "$secret" ] || die "No INGEST_SECRET." "Set it in the environment with --non-interactive."
    env_file_set "$SHAPE_ENV" INGEST_SECRET "$secret"
    env_file_unset "$SHAPE_ENV" BOX_KEY
    info "the box uses the gateway's shared secret"
  else
    [ -n "$code" ] || ask code "The one-time code from Instance admin -> Ingest boxes" "" --code
    box="${box:-$(env_file_get "$SHAPE_ENV" BOX_ID)}"
    box="${box:-box-$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9._-' | tr '[:upper:]' '[:lower:]')}"
    ask label "A name for this box, as the sysop sees it" "${label:-$box}"
    ib_enroll "$url" "$code" "$box" "$label"
    env_file_unset "$SHAPE_ENV" INGEST_SECRET
    info "enrolled as $box; the box signs its requests with its own key"
  fi

  step "Feeds and radios"
  ask call "Your callsign, for the APRS-IS login" \
    "${call:-$(env_file_get "$SHAPE_ENV" APRSIS_CALLSIGN | sed 's/^N0CALL$//')}" --call
  call="$(printf '%s' "$call" | tr '[:lower:]' '[:upper:]')"
  ask pass "APRS-IS passcode (-1 = receive-only)" "${pass:-$(env_file_get "$SHAPE_ENV" APRSIS_PASSCODE | sed 's/^00000$//')}"
  ask filter "APRS-IS filter (e.g. r/47.07/15.42/300)" "${filter:-$(env_file_get "$SHAPE_ENV" APRSIS_FILTER)}"
  ask kiss "A KISS TNC over TCP, host[:port] (blank = none)" "${kiss:-$(env_file_get "$SHAPE_ENV" KISS_TNC_HOST)}"
  ask meshcom "A MeshCom node, address=CALL (blank = none)" "${meshcom:-$(env_file_get "$SHAPE_ENV" MESHCOM_NODE)}"
  env_file_set "$SHAPE_ENV" APRSIS_CALLSIGN "$call"
  env_file_set "$SHAPE_ENV" APRSIS_PASSCODE "${pass:--1}"
  [ -z "$filter" ] || env_file_set "$SHAPE_ENV" APRSIS_FILTER "$filter"
  if [ -n "$kiss" ]; then
    env_file_set "$SHAPE_ENV" KISS_TNC_HOST "${kiss%%:*}"
    [ "${kiss#*:}" = "$kiss" ] || env_file_set "$SHAPE_ENV" KISS_TNC_PORT "${kiss#*:}"
  fi
  if [ -n "$meshcom" ]; then
    env_file_set "$SHAPE_ENV" MESHCOM_NODE "$meshcom"
    # inside the container the listener binds the container's own interface (compose.ingest-only.yml)
    env_file_set "$SHAPE_ENV" MESHCOM_BIND 0.0.0.0
    warn "publish 1799/udp on this host's LAN address in compose.ingest-only.yml (see the comment there)"
  fi
  if [ -n "$kiss" ]; then
    info "A TNC you operate can name this box as its receiving site. It counts for Tier A only once the"
    info "gateway's sysop trusts it under Instance admin -> Trusted receiving stations (or lists it in"
    info "FIRST_PARTY_SITES); leave it blank for someone else's TNC."
    ask site "The receiving site's callsign-SSID (e.g. ${call:-OE8APR}-10; blank = none)" \
      "${site:-$(env_file_get "$SHAPE_ENV" RF_SITE_CALL)}"
    [ -z "$site" ] || env_file_set "$SHAPE_ENV" RF_SITE_CALL "$(printf '%s' "$site" | tr '[:lower:]' '[:upper:]')"
  fi
  shape_record ingest-box "$SHAPE_ENV"

  if [ "$start" = 0 ]; then
    info "Not started (--no-start). Start with: docker compose -f $DEPLOY_DIR/compose.ingest-only.yml up -d --build"
    return 0
  fi
  step "Start"
  ib_compose up -d --build ingest
  sleep 5
  run_doctor || true
}

shape_status() {
  local gw services=""
  gw="$(env_file_get "$SHAPE_ENV" INGEST_URL)"
  if have docker; then services="$(ib_compose ps --format '{{.Service}} {{.State}}' 2>/dev/null || true)"; fi
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

# doctor's ingest checks (check.ts with its arguments), inside the running ingest container: it holds the
# box's key, and the sound card, the PTT device and the ALSA tools are the container's
shape_doctor_ingest_node() {
  ib_compose exec -T -w /app/apps/ingest ingest node --import tsx src/check.ts "$@" 2>/dev/null
}

# doctor's signed credential check, inside the running ingest container (which holds the key)
shape_doctor_signed_check() {
  ib_compose exec -T -w /app/apps/ingest ingest node --import tsx src/check.ts 2>/dev/null ||
    echo "0 the ingest container is not running"
}

# ---- update (deploy/lib/update.sh): this checkout, the ingest image rebuilt and the container restarted.
# An ingest box holds no database, so its update rolls back the code alone.
shape_git() { git -C "$DEPLOY_DIR/.." "$@"; }
shape_update_apply() { ib_compose up -d --build ingest; }
