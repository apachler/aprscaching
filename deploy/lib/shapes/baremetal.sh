# Bare metal: the gateway and the ingest from a checkout under systemd, without Docker — the units in
# deploy/systemd/, run as a dedicated system user, the gateway serving the web app itself. Its settings in
# <dir>/deploy/.env. Sourced by deploy/aprscaching.
#
# Root is needed for four things only, and init lists them before it starts: creating the service user,
# creating the install directory, installing the two units, and enabling them. Everything else (the
# checkout, the dependencies, the build, the .env) runs as the service user.
# shellcheck shell=bash

BM_DIR="${APRSCACHING_BAREMETAL_DIR:-/opt/aprscaching}"
BM_USER="aprscaching"
BM_PORT=8080
BM_UNITS="aprscaching-gateway aprscaching-ingest"
BM_UNIT_DIR="${APRSCACHING_UNIT_DIR:-/etc/systemd/system}"
: "${SHAPE_ENV:=$BM_DIR/deploy/.env}"

bm_usage() {
  cat <<'EOF'
deploy/aprscaching init baremetal [options] [setup options]

Installs aprscaching from a checkout under systemd: a system user, the checkout, its dependencies and
web build, the .env (the Self-host questions), and the gateway and ingest units.

  --dir PATH       install directory                          (default /opt/aprscaching)
  --user NAME      the system user the services run as        (default aprscaching)
  --repo URL       the repository to install from             (default the upstream repository)
  --ref REF        the tag or branch to install               (default the newest v* tag, else main)
  --port PORT      the gateway's port; it serves the web app  (default 8080)
  --no-start       install the units without enabling or starting them
  --dry-run        print every step, run none
Any other option goes to setup.sh (--call, --passcode, --filter, --domain, --lan-host, --fed-peers, …).
EOF
}

# Run as root (directly, or through sudo); with --dry-run, print instead.
bm_root() {
  if [ "$BM_DRY" = 1 ]; then printf '    [root] %s\n' "$*"; return 0; fi
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# Run as the service user, from its home, without a login shell.
bm_user() {
  if [ "$BM_DRY" = 1 ]; then printf '    [%s] %s\n' "$BM_USER" "$*"; return 0; fi
  if [ "$(id -un)" = "$BM_USER" ]; then
    "$@"
  elif [ "$(id -u)" = 0 ]; then
    runuser -u "$BM_USER" -- env HOME="$BM_HOME" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  else
    sudo -u "$BM_USER" -H -- env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  fi
}

# The newest v* tag of the repository, or nothing.
bm_latest_tag() {
  git ls-remote --tags --refs "$1" 'v*' 2>/dev/null | sed 's|.*refs/tags/||' | sort -V | tail -n 1
}

# pnpm as the units call it: an absolute path, through corepack when pnpm itself is not installed.
bm_pnpm_cmd() {
  if have pnpm; then command -v pnpm; else printf '%s pnpm' "$(command -v corepack)"; fi
}

# A unit from deploy/systemd/ with this installation's directory, user, port and pnpm.
bm_render_unit() {
  local src="$1" pnpm_cmd
  pnpm_cmd="$(bm_pnpm_cmd)"
  D="$BM_DIR" U="$BM_USER" P="$BM_PORT" C="$pnpm_cmd" awk '
    BEGIN { d = ENVIRON["D"]; u = ENVIRON["U"]; p = ENVIRON["P"]; c = ENVIRON["C"] }
    { gsub(/\/opt\/aprscaching/, d) }
    /^User=/ { $0 = "User=" u }
    /^Environment=PORT=/ { $0 = "Environment=PORT=" p }
    /^ExecStart=\/usr\/bin\/pnpm / { sub(/^ExecStart=\/usr\/bin\/pnpm/, "ExecStart=" c) }
    { print }' "$src"
}

bm_preflight() {
  local major
  [ "$(uname -s)" = Linux ] || die "Bare metal installs on Linux with systemd."
  have systemctl || die "systemctl is missing." "Bare metal runs the gateway and the ingest as systemd units."
  have git || die "git is missing." "Install it with your package manager (e.g. apt install git)."
  have node || die "Node.js is missing." "Install Node.js 22 or newer (https://nodejs.org or your distribution)."
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node.js $major is too old." "Install Node.js 22 or newer."
  have pnpm || have corepack || die "Neither pnpm nor corepack is available." "Node.js ships corepack; or install pnpm."
  have curl || die "curl is missing." "Install it with your package manager."
  if [ "$(id -u)" != 0 ] && [ "$BM_DRY" != 1 ]; then
    have sudo || die "Run as root, or install sudo: four steps need root."
  fi
}

shape_init() {
  local repo="https://github.com/apachler/aprscaching" ref="" start=1 setup=() kind tmp unit
  BM_DRY=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) BM_DIR="$2"; shift ;;
      --user) BM_USER="$2"; shift ;;
      --repo) repo="$2"; shift ;;
      --ref) ref="$2"; shift ;;
      --port) BM_PORT="$2"; shift ;;
      --no-start) start=0 ;;
      --dry-run) BM_DRY=1 ;;
      -h | --help) bm_usage; return 0 ;;
      *) setup+=("$1") ;;
    esac
    shift
  done
  case "$BM_DIR" in /*) ;; *) die "--dir must be an absolute path." ;; esac
  [[ "$BM_PORT" =~ ^[0-9]+$ ]] || die "--port must be a number."
  BM_HOME="/var/lib/$BM_USER"
  SHAPE_ENV="$BM_DIR/deploy/.env"
  bm_preflight

  if [ -z "$ref" ]; then
    ref="$(bm_latest_tag "$repo")"
    if [ -z "$ref" ]; then
      ref=main
      info "The repository has no release tag; installing the main branch."
    fi
  fi
  kind=tag
  [[ "$ref" =~ ^v[0-9] ]] || kind=branch

  step "Bare metal: $repo at $ref into $BM_DIR, run as $BM_USER on port $BM_PORT"
  info "Steps that need root:"
  info "  1. create the system user $BM_USER (home $BM_HOME), unless it exists"
  info "  2. create $BM_DIR, owned by $BM_USER"
  info "  3. install $BM_UNITS into $BM_UNIT_DIR"
  [ "$start" = 0 ] || info "  4. systemctl daemon-reload, and enable and start both units"
  warn "$ref ($kind) is installed without verification: nothing checks a signature on a git checkout."
  confirm "Install $ref?" || die "Nothing was installed." "Pass --yes to install without asking."

  step "System user"
  if id "$BM_USER" >/dev/null 2>&1; then
    info "$BM_USER exists"
  else
    bm_root useradd --system --create-home --home-dir "$BM_HOME" --shell /usr/sbin/nologin "$BM_USER"
  fi

  step "Checkout"
  if [ -d "$BM_DIR/.git" ]; then
    bm_user git -C "$BM_DIR" fetch --quiet --tags origin
    bm_user git -C "$BM_DIR" checkout --quiet "$ref"
    [ "$kind" = tag ] || bm_user git -C "$BM_DIR" merge --quiet --ff-only "origin/$ref"
  else
    bm_root install -d -o "$BM_USER" -g "$BM_USER" -m 755 "$BM_DIR"
    bm_user git clone --quiet "$repo" "$BM_DIR"
    bm_user git -C "$BM_DIR" checkout --quiet "$ref"
  fi
  # the database and media live here (the units' DB_PATH), owned by the service user
  bm_user mkdir -p "$BM_DIR/data"

  step "Dependencies and the web build"
  # The gateway and the ingest run from source (tsx); the web app is the one thing to build.
  bm_user bash -c "cd '$BM_DIR' && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @aprscaching/web build"

  step "Settings ($SHAPE_ENV)"
  local opts=(--env-file "$SHAPE_ENV" --app-port "$BM_PORT" --no-tunnel --no-next-steps)
  [ "$APRS_INTERACTIVE" = 1 ] || opts+=(--non-interactive)
  [ "$APRS_ASSUME_YES" = 1 ] && opts+=(--yes)
  bm_user bash "$BM_DIR/deploy/setup.sh" "${opts[@]}" "${setup[@]+"${setup[@]}"}"
  bm_user chmod 600 "$SHAPE_ENV"

  step "systemd units"
  tmp="$(mktemp -d)"
  for unit in $BM_UNITS; do
    bm_render_unit "$DEPLOY_DIR/systemd/$unit.service" >"$tmp/$unit.service"
    bm_root install -m 644 "$tmp/$unit.service" "$BM_UNIT_DIR/$unit.service"
  done
  rm -rf "$tmp"
  if [ "$start" = 1 ]; then
    bm_root systemctl daemon-reload
    # The gateway applies the database migrations when it starts.
    # shellcheck disable=SC2086 # two unit names
    bm_root systemctl enable --now $BM_UNITS
  else
    info "Not enabled (--no-start). Start with: sudo systemctl daemon-reload && sudo systemctl enable --now $BM_UNITS"
  fi

  [ "$BM_DRY" = 1 ] && return 0
  shape_record baremetal "$SHAPE_ENV"
  if [ "$start" = 1 ]; then bm_wait_health; fi
  bm_next_steps
}

# The gateway answers once it has migrated the database; wait up to a minute.
bm_wait_health() {
  local _
  step "Health"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$BM_PORT/health" >/dev/null 2>&1; then
      info "the gateway answers on http://127.0.0.1:$BM_PORT/health"
      return 0
    fi
    sleep 2
  done
  warn "the gateway has not answered yet; see: journalctl -u aprscaching-gateway -n 50"
}

bm_next_steps() {
  local call url run
  call="$(env_file_get "$SHAPE_ENV" ADMIN_CALLSIGNS)"
  call="${call%%,*}"
  url="$(env_file_get "$SHAPE_ENV" APP_URL)"
  run="sudo -u $BM_USER bash -c 'cd $BM_DIR && set -a && . deploy/.env && PORT=$BM_PORT node tools/admin/"
  step "Next"
  info "1. Sign in: open ${url:-http://<this host>:$BM_PORT} and create the account for ${call:-your call}."
  case "$url" in http://*)
    info "   Plain http has no passkeys; sign in with a one-time link:"
    info "   ${run}signin-link.mjs ${call:-<CALL>}'"
    ;;
  esac
  info "2. Verify your call: ${run}verify-call.mjs ${call:-<CALL>}'"
  info "3. Finish: Instance admin -> Setup lists what is left to configure."
  case "$url" in https://*) info "Your reverse proxy forwards $url to http://127.0.0.1:$BM_PORT." ;; esac
}

shape_status() {
  local port unit state states="" health="" ok=0
  port="$(sed -n 's/^Environment=PORT=//p' "$BM_UNIT_DIR/aprscaching-gateway.service" 2>/dev/null)"
  port="${port:-$BM_PORT}"
  for unit in $BM_UNITS; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    states="$states$unit ${state:-unknown}"$'\n'
  done
  if health="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null)"; then ok=1; fi
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"baremetal","port":%s,"healthy":%s,"health":%s,"services":%s}\n' "$port" \
      "$([ "$ok" = 1 ] && echo true || echo false)" "${health:-null}" "$(json_str "${states%$'\n'}")"
    return 0
  fi
  step "Bare metal on port $port"
  if [ "$ok" = 1 ]; then info "health: $health"; else info "health: no answer from http://127.0.0.1:$port/health"; fi
  while IFS= read -r line; do [ -z "$line" ] || info "$line"; done <<<"$states"
}

# backup: deploy/backup.sh with this installation's settings and database, as the service user.
shape_backup() {
  local dir
  [ -f "$SHAPE_ENV" ] || die "$SHAPE_ENV is missing." "Run deploy/aprscaching init baremetal first."
  dir="$(dirname "$(dirname "$SHAPE_ENV")")"
  BM_DRY=0
  BM_HOME="/var/lib/$BM_USER"
  bm_user bash -c "set -a && . '$SHAPE_ENV' && set +a && DB_PATH='$dir/data/aprscaching.db' exec '$dir/deploy/backup.sh'"
}
