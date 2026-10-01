# Cloudflare split: the gateway as a Worker with D1 and R2, the web app on Pages, deployed with wrangler
# from workers/gateway. Its secrets live in the Worker (wrangler secret), not in a .env. Sourced by
# deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

CF_WORKER_DIR="$DEPLOY_DIR/../workers/gateway"

# init cloudflare: the advanced shape, kept to the existing one-shot. It says what it costs, runs
# cloudflare/deploy-cf.sh, and records the Worker's and the app's URLs for status and doctor.
shape_init() {
  local api="${API_BASE:-}" app=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --api-base) api="$2"; shift ;;
      --app-url) app="$2"; shift ;;
      -h | --help)
        printf '%s\n' "deploy/aprscaching init cloudflare [--api-base URL] [--app-url URL]" \
          "Runs deploy/cloudflare/deploy-cf.sh (wrangler, logged in) and records the Worker's and the app's URLs."
        return 0
        ;;
      *) die "Unknown option $1." ;;
    esac
    shift
  done
  step "Cloudflare split (advanced)"
  info "The gateway runs on Cloudflare, and D1 bills every row written: the cost grows with your feed."
  info "Self-host behind a Cloudflare Tunnel gives the same edge without that cost:"
  info "  deploy/aprscaching init selfhost  (choose the Cloudflare Tunnel)"
  info "Sizing and the write budget: docs/reference/cloudflare-costs.md"
  confirm "Deploy the Cloudflare split anyway?" || die "Nothing was deployed." "Pass --yes to deploy without asking."
  have wrangler || die "wrangler is not installed." "npm i -g wrangler, then wrangler login."
  ask api "The Worker's public URL (e.g. https://api.example.net or https://aprscaching.<you>.workers.dev)" "$api" --api-base
  ask app "The app's public URL on Pages (e.g. https://aprs.example.net)" "$app" --app-url
  API_BASE="$api" bash "$DEPLOY_DIR/cloudflare/deploy-cf.sh"
  shape_record cloudflare "" "api=${api%/}" "app=${app%/}"
  step "Next"
  info "1. Set the Worker's APP_URL to $app (wrangler.toml [vars]) if deploy-cf.sh did not."
  info "2. Your RF box: create a code in Instance admin -> Ingest boxes, then on the box run"
  info "   deploy/aprscaching init ingest-box --gateway ${api%/}"
  info "3. Check it: deploy/aprscaching doctor (with OPERATOR_SECRET in the environment to read Setup)."
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

# ---- backup and restore (deploy/lib/backup.sh) through wrangler, on the remote D1 database. R2 media is not
# part of these archives: D1 Time Travel and an R2 copy cover them (docs/operate/deployment.md, Backups).
cf_db() { sed -n 's/^database_name *= *"\(.*\)"/\1/p' "$CF_WORKER_DIR/wrangler.toml" | head -n 1; }
cf_wrangler() { (cd "$CF_WORKER_DIR" && wrangler "$@"); }
cf_need() { have wrangler || die "wrangler is not installed." "npm i -g wrangler, then wrangler login."; }

# A one-value SQL query on the remote database, the value on stdout.
cf_query() {
  cf_wrangler d1 execute "$(cf_db)" --remote --json --command "$1" 2>/dev/null |
    node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const r=(j[0]||j).results||[];for(const x of r)console.log(Object.values(x)[0])'
}

shape_db_dump() {
  local schema out
  cf_need
  schema="$(cf_query "SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1" | head -n 1)"
  [ -n "$schema" ] || die "The D1 database reports no applied migration."
  out="$(mktemp)"
  cf_wrangler d1 export "$(cf_db)" --remote --no-schema --output "$out" >&2
  node "$DEPLOY_DIR/../tools/backup/db.mjs" from-d1 "$schema" <"$out"
  rm -f "$out"
}

shape_db_restore() {
  local current tables sql
  cf_need
  current="$(cf_query "SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1" | head -n 1)"
  [ "$current" = "$2" ] || die "D1 is at $current, the backup at $2." \
    "Restore into D1 at the backup's schema: apply its migrations, or restore on a self-hosted shape first."
  info "D1 Time Travel can undo this restore; the bookmark of the present moment:"
  cf_wrangler d1 time-travel info "$(cf_db)" >&2 || true
  tables="$(cf_query "SELECT name FROM sqlite_master WHERE type = 'table'" | paste -sd, -)"
  sql="$(mktemp)"
  node "$DEPLOY_DIR/../tools/backup/db.mjs" to-d1 "$tables" <"$1" >"$sql"
  cf_wrangler d1 execute "$(cf_db)" --remote --yes --file "$sql" >&2
  rm -f "$sql"
}

# The Worker keeps its settings as secrets and vars: secrets go back with wrangler, vars are listed.
shape_settings_restore() {
  local key value vars=()
  cf_need
  while IFS= read -r key; do
    case "$BACKUP_HOST_KEYS" in *" $key "*) continue ;; esac
    cfg_known "$key" && [[ "$(cfg_field "$key" 3)" == *gateway* ]] || continue
    value="$(env_file_get "$1" "$key")"
    [ -n "$value" ] || continue
    if cfg_secret "$key"; then
      printf '%s' "$value" | cf_wrangler secret put "$key" >/dev/null
      info "secret $key set in the Worker"
    else
      vars+=("$key")
    fi
  done < <(env_file_keys "$1")
  [ "${#vars[@]}" = 0 ] || info "Set these in wrangler.toml [vars] from the backup's settings: ${vars[*]}"
}

# ---- update (deploy/lib/update.sh): this checkout, published with cloudflare/publish.sh (migrations, the
# Worker, the app). A rollback takes D1 back with Time Travel to the moment before the update.
shape_git() { git -C "$DEPLOY_DIR/.." "$@"; }
shape_update_apply() {
  local api
  cf_need
  api="${APRSCACHING_API_BASE:-$(cf_recorded api || true)}"
  [ -n "$api" ] || die "The Worker's URL is not known here." "Set APRSCACHING_API_BASE=https://…"
  API_BASE="$api" bash "$DEPLOY_DIR/cloudflare/publish.sh"
}
shape_rollback_db() {
  local at
  at="$(date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ)"
  cf_wrangler d1 time-travel restore "$(cf_db)" --timestamp="$at" ||
    die "D1 Time Travel did not restore." "Run it yourself: (cd workers/gateway && wrangler d1 time-travel restore $(cf_db) --timestamp=$at)"
}
