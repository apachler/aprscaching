# Cloudflare split: the gateway as a Worker with D1 and R2, the web app on Pages, deployed with wrangler
# from workers/gateway. Its secrets live in the Worker (wrangler secret), not in a .env. Sourced by
# deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

CF_WORKER_DIR="$DEPLOY_DIR/../workers/gateway"

shape_init() {
  bash "$DEPLOY_DIR/cloudflare/deploy-cf.sh" "$@"
  shape_record cloudflare ""
}

# rotate-secret NAME: a fresh value stored in the Worker with wrangler, which redeploys it.
shape_rotate_secret() {
  local name="$1" effect value
  effect="$(rotate_effect "$name")" || die "$name is not a secret this helper rotates."
  have wrangler || die "wrangler is not installed." "Install it (npm i -g wrangler) and run wrangler login."
  info "Rotating $name in the Worker: $effect."
  confirm "Replace $name?" || die "Kept $name." "Pass --yes to rotate without asking."
  value="$(gen_secret)"
  (cd "$CF_WORKER_DIR" && printf '%s' "$value" | wrangler secret put "$name" >/dev/null)
  info "$name replaced in the Worker."
  if [ "$name" = INGEST_SECRET ]; then
    info "The new value, for your ingest boxes (shown only now): $value"
  fi
}

# The Worker's public URL and the Pages app's, as init recorded them (or APRSCACHING_API_BASE /
# APRSCACHING_APP_URL).
cf_recorded() { [ -f "$SHAPE_FILE" ] && sed -n "s/^$1=//p" "$SHAPE_FILE" | tail -n 1; }

shape_status() {
  local api app health="" ok=0
  api="${APRSCACHING_API_BASE:-$(cf_recorded api || true)}"
  app="${APRSCACHING_APP_URL:-$(cf_recorded app || true)}"
  [ -n "$api" ] || die "The Worker's URL is not known here." "Set APRSCACHING_API_BASE=https://… (init cloudflare records it)."
  if health="$(curl -fsS --max-time 8 "${api%/}/health" 2>/dev/null)"; then ok=1; fi
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"cloudflare","api":%s,"app":%s,"healthy":%s,"health":%s}\n' "$(json_str "$api")" "$(json_str "$app")" \
      "$([ "$ok" = 1 ] && echo true || echo false)" "${health:-null}"
    return 0
  fi
  step "Cloudflare split: Worker at $api${app:+, app at $app}"
  if [ "$ok" = 1 ]; then info "health: $health"; else info "health: no answer from ${api%/}/health"; fi
}

# doctor: the Worker and the Pages app over the internet. The Worker's secrets are not readable here, so
# the Setup checklist (and with it the D1 write budget) is read when OPERATOR_SECRET is in the environment.
shape_doctor_context() {
  DOC_BASE="${APRSCACHING_API_BASE:-$(cf_recorded api || true)}"
  DOC_PUBLIC="${APRSCACHING_APP_URL:-$(cf_recorded app || true)}"
  DOC_BASE="${DOC_BASE%/}"
  [ -n "$DOC_BASE" ] || failc config.api "the Worker's URL is not known here" "set APRSCACHING_API_BASE=https://…"
}

shape_doctor_extra() {
  local index asset
  pass resources.backup "D1 Time Travel keeps the database restorable for 30 days (7 on Workers Free)"
  [ -n "$DOC_PUBLIC" ] && [ -n "$DOC_BASE" ] || return 0
  # The Pages build bakes in the Worker's URL (VITE_API_BASE): it must be this Worker.
  index="$(curl -fsS --max-time 10 "$DOC_PUBLIC" 2>/dev/null || true)"
  asset="$(printf '%s' "$index" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -n 1)"
  if [ -z "$asset" ]; then
    failc pages.app "the app at $DOC_PUBLIC does not answer" "deploy the Pages project"
  elif curl -fsS --max-time 15 "${DOC_PUBLIC%/}$asset" 2>/dev/null | grep -qF "$DOC_BASE"; then
    pass pages.api_base "the app at $DOC_PUBLIC talks to $DOC_BASE"
  else
    failc pages.api_base "the app at $DOC_PUBLIC was built for another gateway" "rebuild it with VITE_API_BASE=$DOC_BASE and redeploy"
  fi
}
