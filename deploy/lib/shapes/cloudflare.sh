# Cloudflare split: the gateway as a Worker with D1 and R2, the web app on Pages, deployed with wrangler
# from workers/gateway. Its secrets live in the Worker (wrangler secret), not in a .env. Sourced by
# deploy/aprscaching.
# shellcheck shell=bash

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
