# Bare metal: the gateway and the ingest from a checkout under systemd, without Docker — the units in
# deploy/systemd/, run as a dedicated system user, the gateway serving the web app itself. Its settings in
# <dir>/deploy/.env. Sourced by deploy/aprscaching.
#
# Three users share the work, so none of the code root runs is writable by a user that runs third-party code:
# - root owns the checkout (deploy/ included, which root runs: the helper, setup.sh, net44) and its .env, and
#   runs git, setup.sh and the units' installation;
# - the build user (<user>-build) runs pnpm install and the web build, whose dependencies' install scripts and
#   build plugins are third-party code; it may write the build's outputs only: every workspace package's
#   node_modules and the web app's dist;
# - the service user runs the units and owns data/, the one place it may write.
# init lists the root steps before it starts.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

BM_DIR="${APRSCACHING_BAREMETAL_DIR:-/opt/aprscaching}"
BM_USER="aprscaching"
BM_BUILDER="aprscaching-build"
BM_PORT=8080
BM_UNITS="aprscaching-gateway aprscaching-ingest"
BM_UNIT_DIR="${APRSCACHING_UNIT_DIR:-/etc/systemd/system}"
: "${SHAPE_ENV:=$BM_DIR/deploy/.env}"

bm_usage() {
  cat <<'EOF'
deploy/aprscaching init baremetal [options] [setup options]

Installs APRScaching from a checkout under systemd: a system user, the checkout, its dependencies and
web build, the .env (the Self-host questions), and the gateway and ingest units.

  --dir PATH       install directory                          (default /opt/aprscaching)
  --user NAME      the system user the services run as        (default aprscaching;
                   the build runs as NAME-build)
  --repo URL       the repository to install from             (default the upstream repository)
  --ref REF        the tag or branch to install               (default the newest v* tag, else main)
  --port PORT      the gateway's port; it serves the web app  (default 8080)
  --no-start       install the units without enabling or starting them
  --checksum-only  install a release verified by its checksum alone, when gh is not installed
  --unverified     install a branch, a commit or a tag without a verified bundle without asking
  --dry-run        print every step, run none; a release tag is still downloaded and checked
  --net44-config FILE  bring a 44Net Connect tunnel up afterwards (deploy/aprscaching net44 setup)
Any other option goes to setup.sh (--call, --passcode, --filter, --domain, --lan-host, --fed-peers, …).
EOF
}

# Run as root (directly, or through sudo); with --dry-run, print instead.
bm_root() {
  if [ "$BM_DRY" = 1 ]; then printf '    [root] %s\n' "$*"; return 0; fi
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# Run as USER, from HOME, without a login shell: bm_as USER HOME command…
bm_as() {
  local user="$1" home="$2"
  shift 2
  if [ "$BM_DRY" = 1 ]; then printf '    [%s] %s\n' "$user" "$*"; return 0; fi
  if [ "$(id -un)" = "$user" ]; then
    "$@"
  elif [ "$(id -u)" = 0 ]; then
    runuser -u "$user" -- env HOME="$home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  else
    sudo -u "$user" -H -- env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  fi
}
bm_user() { bm_as "$BM_USER" "$BM_HOME" "$@"; }
bm_build() { bm_as "$BM_BUILDER" "/var/lib/$BM_BUILDER" "$@"; }

# git in the checkout, as root, with the world-readable modes the service user needs to read the code: an
# operator's umask of 077 would otherwise leave every file root's alone.
bm_git() {
  if [ "$BM_DRY" = 1 ]; then printf '    [root] git %s\n' "$*"; return 0; fi
  bm_root sh -c 'umask 022 && exec git "$@"' git "$@"
}

# The owner of a path, by name.
bm_owner() { stat -c %U "$1"; }

# The build's outputs, relative to the checkout whose layout ROOT shows: node_modules at the top and in every
# workspace package (the globs of pnpm-workspace.yaml), and the web app's dist. Read from the workspace file,
# so a package added there gets its node_modules without a change here.
bm_build_paths() {
  local root="$1" glob d
  echo node_modules
  while IFS= read -r glob; do
    for d in "$root"/$glob; do
      [ -f "$d/package.json" ] && echo "${d#"$root"/}/node_modules"
    done
  done < <(awk '/^packages:/ { on = 1; next } on && /^[^ #-]/ { on = 0 }
    on && /^ *- / { sub(/^ *- */, ""); gsub(/["\047]/, ""); print }' "$root/pnpm-workspace.yaml")
  echo apps/web/dist
}

# The build's outputs exist, the build user's, before it runs: the checkout around them is root's.
bm_build_dirs() {
  local layout="$BM_DIR" p
  [ "$BM_DRY" != 1 ] || layout="$DEPLOY_DIR/.."
  while IFS= read -r p; do
    [ -d "$BM_DIR/$p" ] || bm_root install -d -o "$BM_BUILDER" -g "$BM_BUILDER" -m 755 "$BM_DIR/$p"
  done < <(bm_build_paths "$layout")
}

# The dependencies and the web build, as the build user. umask 022: the service user reads what it writes. The
# store is named, in the build user's home where pnpm keeps it anyway: without one, pnpm writes a probe file into
# the checkout's top directory to choose it, and that directory is root's.
bm_build_run() {
  bm_build bash -c "umask 022 && cd '$BM_DIR' && corepack pnpm install --frozen-lockfile --store-dir \"\$HOME/.local/share/pnpm/store\" &&
    corepack pnpm --filter @aprscaching/web build"
}

# The units start pnpm through corepack when pnpm itself is not installed; corepack keeps that pnpm in the
# service user's home, which the units see read-only, so it is fetched there now.
bm_pnpm_for_service() {
  have pnpm || bm_user bash -c "cd '$BM_DIR' && corepack pnpm --version >/dev/null"
}

bm_ensure_user() { # bm_ensure_user NAME
  if id "$1" >/dev/null 2>&1; then
    info "$1 exists"
  else
    bm_root useradd --system --create-home --home-dir "/var/lib/$1" --shell /usr/sbin/nologin "$1"
  fi
}

# A checkout where the service user owns anything outside data/ is handed to root: the service user could
# rewrite the helper root runs. The build's outputs were the service user's to write, so they are removed rather
# than handed on, and the next build installs them afresh. data/ stays the service user's.
bm_checkout_is_service_users() {
  [ -e "$BM_DIR/.git" ] && [ -n "$(find "$BM_DIR" -path "$BM_DIR/data" -prune -o -user "$BM_USER" -print -quit 2>/dev/null)" ]
}
bm_take_checkout() {
  bm_checkout_is_service_users || return 0
  step "Handing the checkout to root"
  local p
  while IFS= read -r p; do bm_root rm -rf "${BM_DIR:?}/$p"; done < <(bm_build_paths "$BM_DIR")
  bm_root chown root:root "$BM_DIR"
  bm_root chmod 755 "$BM_DIR"
  # -h and -R without -L: a symbolic link is changed itself, never followed out of the checkout. go-w too: a mode
  # or an ACL entry the service user set would otherwise keep a root-owned file writable to it.
  bm_root find "$BM_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec chown -hR root:root {} +
  bm_root find "$BM_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec chmod -R go-w {} +
  info "the checkout is root's, data/ stays $BM_USER's"
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
    # ProtectHome=yes hides /home, /root and /run/user, so a checkout there gets them read-only instead
    /^ProtectHome=yes$/ && d ~ /^\/(home|root|run\/user)(\/|$)/ { $0 = "ProtectHome=read-only" }
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
  local repo="https://github.com/apachler/aprscaching" ref="" start=1 setup=() kind tmp unit bundle="" net44=""
  BM_DRY=0
  REL_ALLOW_UNSIGNED=0
  REL_ALLOW_UNVERIFIED=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) BM_DIR="$2"; shift ;;
      --user) BM_USER="$2"; shift ;;
      --repo) repo="$2"; shift ;;
      --ref) ref="$2"; shift ;;
      --port) BM_PORT="$2"; shift ;;
      --no-start) start=0 ;;
      --checksum-only) REL_ALLOW_UNSIGNED=1 ;;
      --unverified) REL_ALLOW_UNVERIFIED=1 ;;
      --dry-run) BM_DRY=1 ;;
      --net44-config) net44="$2"; shift ;;
      -h | --help) bm_usage; return 0 ;;
      *) setup+=("$1") ;;
    esac
    shift
  done
  case "$BM_DIR" in /*) ;; *) die "--dir must be an absolute path." ;; esac
  [[ "$BM_PORT" =~ ^[0-9]+$ ]] || die "--port must be a number."
  BM_HOME="/var/lib/$BM_USER"
  BM_BUILDER="$BM_USER-build"
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
  info "  1. create the system users $BM_USER (runs the services) and $BM_BUILDER (runs the build), unless they exist"
  info "  2. create $BM_DIR and fill it with the checkout, root's; data/ for $BM_USER, the build's outputs for $BM_BUILDER"
  info "  3. write $SHAPE_ENV (setup.sh), root's"
  info "  4. install $BM_UNITS into $BM_UNIT_DIR"
  [ "$start" = 0 ] || info "  5. systemctl daemon-reload, and enable and start both units"
  # verified in a dry run too, so it shows what the install would do; the check changes nothing
  local rc=1 out commit=""
  if [ "$kind" = tag ]; then
    out="$(rel_verified_bundle "$repo" "$ref")" && rc=0 || rc=$?
  fi
  [ "$rc" != 2 ] || die "The release $ref did not verify." "Nothing was installed."
  if [ "$rc" = 0 ]; then
    read -r commit bundle <<<"$out"
    rm_on_exit "$(dirname "$bundle")"
    info "the release $ref is verified: its checksum and its signed provenance"
    confirm "Install $ref?" || die "Nothing was installed." "Pass --yes to install without asking."
  else
    rel_confirm_unverified "$ref" "$kind" "Install $ref without verification?" ||
      die "Nothing was installed." "Pass --unverified to install it without asking; --yes alone does not."
  fi

  step "System users"
  bm_ensure_user "$BM_USER"
  bm_ensure_user "$BM_BUILDER"

  step "Checkout"
  bm_take_checkout
  if [ -n "$bundle" ]; then
    # from the verified bundle; origin stays the repository, for later updates
    if [ -d "$BM_DIR/.git" ]; then
      bm_git -C "$BM_DIR" fetch --quiet "$bundle" "refs/tags/$ref:refs/tags/$ref"
    else
      bm_root install -d -o root -g root -m 755 "$BM_DIR"
      bm_git clone --quiet "$bundle" "$BM_DIR"
      bm_git -C "$BM_DIR" remote set-url origin "$repo"
    fi
    # the commit the verified bundle's tag names, whatever a tag of that name in the checkout says
    bm_git -C "$BM_DIR" -c advice.detachedHead=false checkout --quiet "$commit"
  elif [ -d "$BM_DIR/.git" ]; then
    bm_git -C "$BM_DIR" fetch --quiet --tags origin
    bm_git -C "$BM_DIR" checkout --quiet "$ref"
    [ "$kind" = tag ] || bm_git -C "$BM_DIR" merge --quiet --ff-only "origin/$ref"
  else
    bm_root install -d -o root -g root -m 755 "$BM_DIR"
    bm_git clone --quiet "$repo" "$BM_DIR"
    bm_git -C "$BM_DIR" checkout --quiet "$ref"
  fi
  # the database and media live here (the units' DB_PATH), the service user's alone: the database holds
  # account emails and unused sign-in tokens
  bm_root install -d -o "$BM_USER" -g "$BM_USER" -m 700 "$BM_DIR/data"

  step "Dependencies and the web build"
  # The gateway and the ingest run from source (tsx); the web app is the one thing to build.
  bm_build_dirs
  bm_build_run
  bm_pnpm_for_service

  step "Settings ($SHAPE_ENV)"
  local opts=(--env-file "$SHAPE_ENV" --app-port "$BM_PORT" --no-tunnel --no-next-steps)
  [ "$APRS_INTERACTIVE" = 1 ] || opts+=(--non-interactive)
  [ "$APRS_ASSUME_YES" = 1 ] && opts+=(--yes)
  bm_root bash "$BM_DIR/deploy/setup.sh" "${opts[@]}" "${setup[@]+"${setup[@]}"}"
  # The ingest reaches the gateway on this host, not by the Docker stack's service name.
  bm_root sed -i "s|^INGEST_URL=.*|INGEST_URL=http://127.0.0.1:$BM_PORT/ingest|" "$SHAPE_ENV"
  bm_proxy_bind "$SHAPE_ENV" || die "could not read $SHAPE_ENV as root to set HOST and TRUST_PROXY for the proxy."
  bm_root chmod 600 "$SHAPE_ENV"

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
  n44_init_offer "$net44"
  bm_next_steps
}

# Behind the reverse proxy an https APP_URL names, the gateway listens on 127.0.0.1 alone and keys rate limits on
# the X-Forwarded-For entry that proxy wrote: a client that reached the port directly would choose its own. A
# value the operator set stays. A plain-http APP_URL is the gateway itself, reached on every interface.
# The file is root's alone (mode 600), so root reads and writes it: an installer that cannot read it must not
# take the refusal for an unset APP_URL. Fails when the file cannot be read.
bm_proxy_bind() {
  # shellcheck disable=SC2016 # the script expands in root's shell
  bm_root bash -c 'set -e
    . "$1/deploy/lib/env.sh"
    [ -r "$2" ] || { echo "cannot read $2" >&2; exit 1; }
    case "$(env_file_get "$2" APP_URL)" in https://*) ;; *) exit 0 ;; esac
    env_file_has "$2" HOST || env_file_set "$2" HOST 127.0.0.1
    env_file_has "$2" TRUST_PROXY || env_file_set "$2" TRUST_PROXY 1' _ "$BM_DIR" "$1"
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
  # root reads the .env, the service user runs the tool, which writes the database
  run="sudo bash -c 'cd $BM_DIR && set -a && . deploy/.env && PORT=$BM_PORT runuser -u $BM_USER -- node tools/admin/"
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

# doctor: the gateway on this host, its database under the install directory.
shape_doctor_context() {
  local dir port
  dir="$(dirname "$(dirname "$SHAPE_ENV")")"
  port="$(sed -n 's/^Environment=PORT=//p' "$BM_UNIT_DIR/aprscaching-gateway.service" 2>/dev/null)"
  DOC_ENV="$SHAPE_ENV"
  DOC_BASE="http://127.0.0.1:${port:-$BM_PORT}"
  DOC_PUBLIC="$(env_file_get "$SHAPE_ENV" APP_URL)"
  DOC_INGEST="$(env_file_get "$SHAPE_ENV" INGEST_URL)"
  DOC_INGEST="${DOC_INGEST:-$DOC_BASE/ingest}"
  DOC_DATA_DIR="$dir/data"
  DOC_DB_FILE="$dir/data/aprscaching.db"
  DOC_BACKUP_SETTINGS=1
}

# doctor's ingest checks (apps/ingest/src/check.ts): root loads the .env, which is root's, and the service user
# runs node, since the code it loads includes the dependencies the build user installed. sudo -n: doctor never
# waits on a password prompt it hides.
bm_ingest_check() {
  local u
  u="$(sed -n 's/^User=//p' "$BM_UNIT_DIR/aprscaching-gateway.service" 2>/dev/null)"
  # shellcheck disable=SC2016 # the script expands in root's shell
  set -- bash -c 'set -a && . "$1" && set +a && cd "$2/apps/ingest" && shift 3 &&
    exec runuser -u "$0" -- node --import tsx src/check.ts "$@"' "${u:-$BM_USER}" "$DOC_ENV" "$(bm_dir)" _ "$@"
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi 2>/dev/null
}
shape_doctor_signed_check() { bm_ingest_check; }
shape_doctor_ingest_node() { bm_ingest_check "$@"; }

shape_doctor_extra() {
  local unit state
  for unit in $BM_UNITS; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = active ]; then pass "service.$unit" "$unit is running"; else
      failc "service.$unit" "$unit is ${state:-not installed}" "sudo systemctl enable --now $unit; journalctl -u $unit -n 50"
    fi
  done
  case "$DOC_INGEST" in http://gateway:*) failc ingest.url "INGEST_URL names the Docker service 'gateway', which bare metal has not" \
    "set INGEST_URL=$DOC_BASE/ingest in $DOC_ENV" ;; esac
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

# ---- backup and restore (deploy/lib/backup.sh): the installation's own checkout and data directory, as
# the service user.
bm_dir() { dirname "$(dirname "$SHAPE_ENV")"; }
bm_ctx() {
  local u
  BM_DRY=0
  BM_DIR="$(bm_dir)"
  # the service user the installed units name, --user at init
  u="$(sed -n 's/^User=//p' "$BM_UNIT_DIR/aprscaching-gateway.service" 2>/dev/null)"
  BM_USER="${u:-$BM_USER}"
  BM_HOME="/var/lib/$BM_USER"
  BM_BUILDER="$BM_USER-build"
  [ -f "$SHAPE_ENV" ] || die "$SHAPE_ENV is missing." "Run deploy/aprscaching init baremetal first."
}
shape_db_dump() {
  bm_ctx
  bm_user node "$(bm_dir)/tools/backup/db.mjs" dump "$(bm_dir)/data/aprscaching.db"
}
shape_db_restore() {
  local dir ts f
  bm_ctx
  dir="$(bm_dir)"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  bm_user rm -f "$dir/data/restore.db"
  bm_user node "$dir/tools/backup/db.mjs" restore "$dir/data/restore.db" "$dir/db/migrations" "$2" ${3:+--exact} <"$1" >&2
  for f in aprscaching.db aprscaching.db-wal aprscaching.db-shm; do
    if [ -e "$dir/data/$f" ]; then bm_user mv "$dir/data/$f" "$dir/data/before-restore-$ts-$f"; fi
  done
  bm_user mv "$dir/data/restore.db" "$dir/data/aprscaching.db"
}
shape_secrets_dump() {
  bm_ctx
  bm_user sh -c 'cd "$0" && set -- *.secret && if [ -e "$1" ]; then tar -cf - "$@"; else tar -cf - -T /dev/null; fi' "$(bm_dir)/data" |
    tar -xf - -C "$1"
}
shape_secrets_restore() {
  bm_ctx
  tar -cf - -C "$1" . | bm_user sh -c 'cd "$0" && tar -xf - && chmod 600 ./*.secret' "$(bm_dir)/data"
}
shape_media_dump() {
  bm_ctx
  bm_user sh -c 'mkdir -p "$0" && cd "$0" && tar -cf - .' "$(bm_dir)/data/media" | tar -xf - -C "$1"
}
shape_media_restore() {
  bm_ctx
  tar -cf - -C "$1" . | bm_user sh -c 'mkdir -p "$0" && cd "$0" && tar -xf -' "$(bm_dir)/data/media"
}
# shellcheck disable=SC2086 # two unit names
shape_stop() { bm_root systemctl stop $BM_UNITS; }
# shellcheck disable=SC2086 # two unit names
shape_start() { bm_root systemctl start $BM_UNITS; }

# ---- update (deploy/lib/update.sh): the installation's checkout as root, its dependencies and web build as the
# build user, then the units restarted; the gateway applies new migrations when it starts.
# git runs as the checkout's owner: root, or the service user in a checkout the update has yet to hand to root.
shape_git() {
  bm_ctx
  if [ "$(bm_owner "$BM_DIR/.git")" = root ]; then bm_git -C "$BM_DIR" "$@"; else bm_user git -C "$BM_DIR" "$@"; fi
}
# update at the target still hands a checkout the service user owns to root: the update that brought it there
# ran the helper it replaced.
shape_update_pending() {
  bm_ctx
  bm_checkout_is_service_users
}
shape_update_apply() {
  bm_ctx
  bm_ensure_user "$BM_BUILDER" >/dev/null
  bm_take_checkout
  bm_build_dirs
  bm_build_run || return 1
  bm_pnpm_for_service || return 1
  # shellcheck disable=SC2086 # two unit names
  bm_root systemctl restart $BM_UNITS
}
