# Bare metal: the gateway and the ingest from a checkout under systemd, without Docker — the units in
# deploy/systemd/, run as a dedicated system user, the gateway serving the web app itself. Its settings in
# <dir>/deploy/.env. Sourced by deploy/aprscaching.
#
# Root is needed for four things only, and init lists them before it starts: creating the service user,
# creating the install directory, installing the two units, and enabling them. Everything else (the
# checkout, the dependencies, the build, the .env) runs as the service user.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

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
  --checksum-only  install a release verified by its checksum alone, when gh is not installed
  --dry-run        print every step, run none
  --net44-config FILE  bring a 44Net Connect tunnel up afterwards (deploy/aprscaching net44 setup)
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

# The GitHub owner/name of a repository URL, or nothing for another host.
bm_github_repo() { printf '%s' "$1" | sed -n -E 's#^https://github\.com/([^/]+/[^/.]+)(\.git)?/?$#\1#p'; }

# A release's git bundle, verified: its checksum in the release's SHA256SUMS and its signed provenance
# (gh attestation verify). Prints the bundle's path. Returns 1 when the release has no bundle (the caller
# installs from git, warned) and 2 when a bundle does not verify (the caller stops): it runs in a command
# substitution, where a die would end only the subshell.
bm_verified_bundle() {
  local gh_repo="$1" tag="$2" dir base
  gh_repo="$(bm_github_repo "$gh_repo")"
  [ -n "$gh_repo" ] || return 1
  dir="$(mktemp -d)"
  chmod 755 "$dir" # the service user clones from here
  base="https://github.com/$gh_repo/releases/download/$tag"
  curl -fsSL -o "$dir/aprscaching-$tag.bundle" "$base/aprscaching-$tag.bundle" 2>/dev/null &&
    curl -fsSL -o "$dir/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null || {
    rm -rf "$dir"
    return 1
  }
  if ! (cd "$dir" && grep " aprscaching-$tag.bundle\$" SHA256SUMS | sha256sum -c --quiet -) >&2; then
    printf '\nERROR: the release bundle does not match its checksum.\n' >&2
    return 2
  fi
  if have gh; then
    if ! gh attestation verify "$dir/aprscaching-$tag.bundle" --repo "$gh_repo" >&2; then
      printf "\nERROR: the release bundle's signed provenance does not verify.\n" >&2
      return 2
    fi
  elif [ "$BM_ALLOW_UNSIGNED" != 1 ]; then
    printf '\nERROR: the GitHub CLI (gh) is needed to verify the release signature.\n' >&2
    printf '       Install it (https://cli.github.com), or pass --checksum-only to rely on the checksum alone.\n' >&2
    return 2
  else
    warn "only the checksum was checked (--checksum-only): it proves the file intact, not who made it"
  fi
  chmod 644 "$dir/aprscaching-$tag.bundle"
  printf '%s' "$dir/aprscaching-$tag.bundle"
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
  BM_ALLOW_UNSIGNED=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) BM_DIR="$2"; shift ;;
      --user) BM_USER="$2"; shift ;;
      --repo) repo="$2"; shift ;;
      --ref) ref="$2"; shift ;;
      --port) BM_PORT="$2"; shift ;;
      --no-start) start=0 ;;
      --checksum-only) BM_ALLOW_UNSIGNED=1 ;;
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
  local rc=1
  if [ "$kind" = tag ] && [ "$BM_DRY" != 1 ]; then
    bundle="$(bm_verified_bundle "$repo" "$ref")" && rc=0 || rc=$?
  fi
  [ "$rc" != 2 ] || die "The release $ref did not verify." "Nothing was installed."
  if [ "$rc" = 0 ]; then
    info "the release $ref is verified: its checksum and its signed provenance"
    confirm "Install $ref?" || die "Nothing was installed." "Pass --yes to install without asking."
  else
    warn "$ref ($kind) is installed without verification: only a release's bundle carries a checksum and a signature."
    confirm "Install $ref?" || die "Nothing was installed." "Pass --yes to install without asking."
  fi

  step "System user"
  if id "$BM_USER" >/dev/null 2>&1; then
    info "$BM_USER exists"
  else
    bm_root useradd --system --create-home --home-dir "$BM_HOME" --shell /usr/sbin/nologin "$BM_USER"
  fi

  step "Checkout"
  if [ -n "$bundle" ]; then
    # from the verified bundle; origin stays the repository, for later updates
    if [ -d "$BM_DIR/.git" ]; then
      bm_user git -C "$BM_DIR" fetch --quiet "$bundle" "refs/tags/$ref:refs/tags/$ref"
    else
      bm_root install -d -o "$BM_USER" -g "$BM_USER" -m 755 "$BM_DIR"
      bm_user git clone --quiet "$bundle" "$BM_DIR"
      bm_user git -C "$BM_DIR" remote set-url origin "$repo"
    fi
    bm_user git -C "$BM_DIR" -c advice.detachedHead=false checkout --quiet "$ref"
    rm -rf "$(dirname "$bundle")"
  elif [ -d "$BM_DIR/.git" ]; then
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
  # The ingest reaches the gateway on this host, not by the Docker stack's service name.
  bm_user sed -i "s|^INGEST_URL=.*|INGEST_URL=http://127.0.0.1:$BM_PORT/ingest|" "$SHAPE_ENV"
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
  n44_init_offer "$net44"
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
  BM_DRY=0
  BM_HOME="/var/lib/$BM_USER"
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

# ---- update (deploy/lib/update.sh): the installation's checkout as the service user, its dependencies and
# web build, then the units restarted; the gateway applies new migrations when it starts.
shape_git() {
  bm_ctx
  bm_user git -C "$(bm_dir)" "$@"
}
shape_update_apply() {
  bm_ctx
  bm_user bash -c "cd '$(bm_dir)' && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @aprscaching/web build" ||
    return 1
  # shellcheck disable=SC2086 # two unit names
  bm_root systemctl restart $BM_UNITS
}
