#!/usr/bin/env bash
# Pocket install: the aprscaching gateway (servers/node, SQLite) and the ingest (apps/ingest) on an Android
# phone in Termux, without root. Installs the Termux packages, fetches the repository, installs only what
# the gateway, the ingest and the web build need, compiles better-sqlite3 for Android, builds the web app,
# writes ~/.aprscaching/.env on the first run and starts the gateway once to apply the migrations.
# Safe to re-run: it updates the checkout, keeps an existing .env and skips work that is already done.
#
#   apt update && apt full-upgrade -y     # first: a half-upgraded Termux breaks curl (and pkg, which uses it)
#   curl -fsSLO https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/install.sh
#   bash install.sh --call OE8APR
#   bash install.sh --call OE8APR --branch dev
#
# Options:
#   --call CALL          your callsign (asked when omitted and a terminal is attached)
#   --repo URL           repository to clone            (APRSCACHING_REPO, default the upstream GitHub repo)
#   --branch NAME        branch to check out            (APRSCACHING_BRANCH, default main)
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, media          (APRSCACHING_DATA, default ~/.aprscaching)
#   --port N             gateway port for a new .env    (default 8787)
#   --web-dist PATH      use a web build made elsewhere (apps/web/dist copied from a PC) instead of building
#   --no-update          use the checkout as it is; do not fetch
#   --build-sqlite       compile better-sqlite3 even when a working binary already loads
#   --skip-pkg           do not run pkg (the tools are installed already)
#   --allow-non-termux   run outside Termux (a Linux box, to test the steps)
#   --dry-run            print the steps and commands without changing anything
#   --no-next-steps      leave out the closing "next steps" (update.sh runs this script)
#   -h, --help
set -euo pipefail

REPO="${APRSCACHING_REPO:-https://github.com/apachler/aprscaching.git}"
BRANCH="${APRSCACHING_BRANCH:-main}"
DIR="${APRSCACHING_DIR:-$HOME/aprscaching}"
DATA="${APRSCACHING_DATA:-$HOME/.aprscaching}"
CALL=""
PORT=8787
WEB_SRC=""
UPDATE=1
FORCE_SQLITE=0
PKG=1
ALLOW_NON_TERMUX=0
DRY=0
NEXT_STEPS=1

# The packages the steps below need. nodejs-lts ships corepack (the pinned pnpm) and headers node-gyp can
# build against; clang brings lld and the llvm tools (ar, ld); python and make drive node-gyp. tmux,
# openssh and termux-api serve running the station (a tmux session, ssh from a PC, battery status).
PACKAGES=(nodejs-lts git python make clang curl tmux openssh termux-api)

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --call) CALL="${2:-}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    --branch) BRANCH="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    --port) PORT="${2:-}"; shift ;;
    --web-dist) WEB_SRC="${2:-}"; shift ;;
    --no-update) UPDATE=0 ;;
    --build-sqlite) FORCE_SQLITE=1 ;;
    --skip-pkg) PKG=0 ;;
    --allow-non-termux) ALLOW_NON_TERMUX=1 ;;
    --dry-run) DRY=1 ;;
    --no-next-steps) NEXT_STEPS=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# The processes run from their package directories, so every path written to the .env is absolute.
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
case "$DATA" in /*) ;; *) DATA="$PWD/$DATA" ;; esac
ENV_FILE="$DATA/.env"
LOG_DIR="$DATA/logs"

# ---- helpers -----------------------------------------------------------------------------------------
step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}
# Run a command, or print it under --dry-run.
run() {
  if [ "$DRY" -eq 1 ]; then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}
# pnpm at the exact version package.json pins (corepack reads packageManager from the checkout).
pnpm_() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 corepack pnpm "$@"; }

is_termux() {
  [ -n "${PREFIX:-}" ] && case "$PREFIX" in */com.termux/*) true ;; *) false ;; esac
}

# ---- 1. environment ----------------------------------------------------------------------------------
step "Checking the environment"
TERMUX=0
if is_termux || command -v termux-info >/dev/null 2>&1; then
  TERMUX=1
  info "Termux (PREFIX=${PREFIX:-?})"
elif [ "$ALLOW_NON_TERMUX" -eq 1 ]; then
  info "not Termux; continuing (--allow-non-termux)"
  PKG=0
else
  die "this script sets up aprscaching inside Termux on Android." \
    "Install Termux from F-Droid (https://f-droid.org/packages/com.termux/) or its GitHub releases," \
    "then run it there. On a Linux box, use the Docker stack (deploy/README.md) instead."
fi
# Shared storage (/sdcard, /storage) has no symlinks or hard links, which pnpm relies on.
case "$DIR/" in
  /sdcard/* | /storage/* | /mnt/sdcard/*)
    die "the checkout ($DIR) is on shared storage, which has no symlinks or hard links." \
      "Keep it under Termux's home directory (the default, ~/aprscaching)." ;;
esac
case "$PORT" in
  '' | *[!0-9]*) die "--port takes a number (got '$PORT')." ;;
esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port must be 1024-65535: lower ports need root."
# The data directory holds the secrets and the database: owner-only.
if [ "$DRY" -eq 0 ]; then
  mkdir -p "$DATA"
  chmod 700 "$DATA"
fi

# ---- 2. Termux packages ------------------------------------------------------------------------------
if [ "$PKG" -eq 1 ]; then
  step "Installing Termux packages: ${PACKAGES[*]}"
  # nodejs (the current line) conflicts with nodejs-lts and does not ship corepack; replacing it silently
  # could break something else the operator runs, so ask them to decide.
  if dpkg -s nodejs >/dev/null 2>&1; then
    die "the Termux package 'nodejs' is installed; Pocket uses 'nodejs-lts', which conflicts with it." \
      "Remove it with:  pkg uninstall nodejs   then run this script again."
  fi
  # A fresh Termux has an old package index and libraries; upgrading first keeps newly installed packages
  # from linking against outdated libraries. --force-confold keeps any config file the operator changed.
  if command -v apt >/dev/null 2>&1; then
    run pkg upgrade -y -o Dpkg::Options::=--force-confold
    run pkg install -y "${PACKAGES[@]}"
  else
    run pkg upgrade
    run pkg install "${PACKAGES[@]}"
  fi
else
  step "Skipping Termux packages (--skip-pkg)"
fi

missing=()
for tool in node git python3 make curl; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
command -v clang >/dev/null 2>&1 || command -v cc >/dev/null 2>&1 || missing+=("clang")
if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$DRY" -eq 1 ]; then
    info "missing now (pkg installs them): ${missing[*]}"
  else
    die "missing tools: ${missing[*]}" "Install them with:  pkg install ${PACKAGES[*]}"
  fi
fi
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  info "node $(node -v)"
  [ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old; aprscaching needs Node 22 or newer." \
    "Install the LTS line with:  pkg install nodejs-lts"
fi

# ---- 3. native build settings ------------------------------------------------------------------------
# node-gyp compiles against Node's common.gypi, whose Android branch names android_ndk_path — a variable
# that exists only in an NDK cross-build. Termux's nodejs-lts points node-gyp at its own patched headers;
# defining the variable as empty also covers a node-gyp that downloads the upstream headers instead.
if [ "$TERMUX" -eq 1 ]; then
  step "Configuring node-gyp for Android"
  GYPI="$HOME/.gyp/include.gypi"
  if [ ! -f "$GYPI" ]; then
    run mkdir -p "$HOME/.gyp"
    if [ "$DRY" -eq 0 ]; then
      printf "{ 'variables': { 'android_ndk_path': '' } }\n" >"$GYPI"
    fi
    info "wrote $GYPI"
  elif grep -q android_ndk_path "$GYPI"; then
    info "kept $GYPI"
  else
    info "$GYPI exists without android_ndk_path; left unchanged (GYP_DEFINES covers this run)"
  fi
  export GYP_DEFINES="${GYP_DEFINES:-android_ndk_path=''}"
fi

# ---- 4. repository -----------------------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  if [ "$UPDATE" -eq 1 ]; then
    step "Updating $DIR to $BRANCH"
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
      info "local changes in $DIR; not updating it (commit or stash them, or pass --no-update)"
    else
      run git -C "$DIR" fetch --quiet origin "$BRANCH"
      if git -C "$DIR" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
        run git -C "$DIR" checkout --quiet "$BRANCH"
      else
        run git -C "$DIR" checkout --quiet -b "$BRANCH" "origin/$BRANCH"
      fi
      run git -C "$DIR" merge --quiet --ff-only "origin/$BRANCH" ||
        die "$DIR has diverged from origin/$BRANCH; resolve it by hand or pass --no-update."
    fi
  else
    step "Using $DIR as it is (--no-update)"
  fi
elif [ -e "$DIR" ]; then
  die "$DIR exists but is not a git checkout." "Move it aside or pass --dir PATH."
else
  step "Cloning $REPO ($BRANCH) to $DIR"
  # A blobless clone fetches file contents on demand: far less to download, and updates stay fast-forwards.
  run git clone --quiet --filter=blob:none --branch "$BRANCH" "$REPO" "$DIR"
fi
if [ "$DRY" -eq 0 ]; then
  [ -f "$DIR/servers/node/src/server.ts" ] || die "$DIR does not look like an aprscaching checkout."
  info "at $(git -C "$DIR" rev-parse --short HEAD) ($(git -C "$DIR" rev-parse --abbrev-ref HEAD))"
fi

# ---- 5. pnpm -----------------------------------------------------------------------------------------
step "Enabling pnpm through corepack"
command -v corepack >/dev/null 2>&1 || [ "$DRY" -eq 1 ] ||
  die "corepack is missing; it ships with Node 22 and 24 (Termux's nodejs-lts)." \
    "Install nodejs-lts (pkg install nodejs-lts), or install pnpm yourself at the version in package.json."
if [ "$DRY" -eq 0 ]; then
  # A pnpm from Termux's own package would shadow corepack's shim; the script calls corepack directly.
  if ! dpkg -s pnpm >/dev/null 2>&1; then corepack enable pnpm 2>/dev/null || true; fi
  (cd "$DIR" && info "pnpm $(pnpm_ --version)")
fi

# ---- 6. dependencies ---------------------------------------------------------------------------------
# Only the gateway, the ingest and the web build, with their workspace dependencies. --ignore-scripts
# skips every install script: workerd (Wrangler's local runtime, a dev dependency of workers/gateway) has
# no Android build and its postinstall fails there, and nothing the phone runs needs one — esbuild,
# Rolldown and Lightning CSS load their Android binaries from optional packages, and better-sqlite3 is
# compiled in the next step.
step "Installing dependencies (gateway, ingest, web)"
FILTERS=(--filter "@aprscaching/node-gateway..." --filter "@aprscaching/ingest..." --filter "@aprscaching/web...")
if [ "$DRY" -eq 1 ]; then
  run corepack pnpm install --frozen-lockfile --ignore-scripts "${FILTERS[@]}"
else
  (cd "$DIR" && pnpm_ install --frozen-lockfile --ignore-scripts "${FILTERS[@]}")
fi

# ---- 7. better-sqlite3 -------------------------------------------------------------------------------
# better-sqlite3 ships prebuilt binaries for Linux, macOS and Windows only. On Android it loads
# build/Release/better_sqlite3.node, compiled here with the node-gyp bundled in pnpm. Loading the module
# is not enough to prove it works (the binary loads on first use), so the check opens a database.
SQLITE_CHECK="const D=require('better-sqlite3');const db=new D(':memory:');console.log('SQLite '+db.prepare('select sqlite_version() v').get().v);db.close()"
sqlite_ok() { (cd "$DIR/servers/node" && node -e "$SQLITE_CHECK") >/dev/null 2>&1; }
build_sqlite() {
  local pkgdir gyp="" candidate version log="$LOG_DIR/better-sqlite3-build.log"
  pkgdir="$(cd "$DIR/servers/node" && node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"
  version="$(cd "$DIR" && pnpm_ --version)"
  for candidate in "${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"/v*/pnpm/"$version"/dist/node_modules/node-gyp/bin/node-gyp.js; do
    [ -f "$candidate" ] && gyp="$candidate"
  done
  mkdir -p "$LOG_DIR"
  info "compiling in $pkgdir (several minutes on a phone; log: $log)"
  if [ -n "$gyp" ]; then
    (cd "$pkgdir" && node "$gyp" rebuild --release --force_build=1 -j max) >"$log" 2>&1
  else
    (cd "$pkgdir" && pnpm_ dlx node-gyp@12 rebuild --release --force_build=1 -j max) >"$log" 2>&1
  fi
}
step "Checking better-sqlite3"
if [ "$DRY" -eq 1 ]; then
  run node -e "$SQLITE_CHECK"
  info "[dry-run] compiles better-sqlite3 with node-gyp when that check fails"
else
  if [ "$FORCE_SQLITE" -eq 1 ] || ! sqlite_ok; then
    build_sqlite || true
  fi
  if ! out="$(cd "$DIR/servers/node" && node -e "$SQLITE_CHECK" 2>&1)"; then
    printf '%s\n' "$out" | tail -n 20 >&2
    die "better-sqlite3 does not load on this device, so the gateway cannot start." \
      "Build log: $LOG_DIR/better-sqlite3-build.log (send its last 50 lines with a bug report:" \
      "  tail -n 50 $LOG_DIR/better-sqlite3-build.log)" \
      "Check that clang, make and python are installed:  pkg install clang make python" \
      "and that ~/.gyp/include.gypi defines android_ndk_path, then run this script again."
  fi
  info "$out"
fi

# ---- 8. web app --------------------------------------------------------------------------------------
WEB_DIST="$DIR/apps/web/dist"
WEB_FROM_ARG=0
if [ -n "$WEB_SRC" ]; then
  step "Using the web build in $WEB_SRC"
  [ "$DRY" -eq 1 ] || [ -f "$WEB_SRC/index.html" ] || die "$WEB_SRC/index.html is missing — pass the dist directory of a web build."
  WEB_DIST="$DATA/web"
  WEB_FROM_ARG=1
  run rm -rf "$WEB_DIST"
  run mkdir -p "$DATA"
  run cp -R "$WEB_SRC" "$WEB_DIST"
else
  # Vite alone: the typecheck in the package's build script adds minutes on a phone and changes nothing
  # in the output. The build is skipped when this commit's is already in place.
  step "Building the web app"
  stamp="$DATA/web-build.commit"
  head_commit=""
  [ "$DRY" -eq 1 ] || head_commit="$(git -C "$DIR" rev-parse HEAD)"
  if [ "$DRY" -eq 0 ] && [ -f "$WEB_DIST/index.html" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$head_commit" ]; then
    info "already built for $(git -C "$DIR" rev-parse --short HEAD)"
  elif [ "$DRY" -eq 1 ]; then
    run corepack pnpm --filter @aprscaching/web exec vite build
  else
    mkdir -p "$LOG_DIR"
    if ! (cd "$DIR" && pnpm_ --filter @aprscaching/web exec vite build) >"$LOG_DIR/web-build.log" 2>&1; then
      tail -n 20 "$LOG_DIR/web-build.log" >&2
      die "the web build failed (log: $LOG_DIR/web-build.log)." \
        "Build it on a PC instead (pnpm --filter @aprscaching/web build), copy apps/web/dist to the phone" \
        "and run this script again with --web-dist PATH."
    fi
    printf '%s\n' "$head_commit" >"$stamp"
    info "built $WEB_DIST"
  fi
fi

# ---- 9. ~/.aprscaching/.env --------------------------------------------------------------------------
# Set KEY to VALUE in the .env: replace the active line, else append.
set_env() {
  local tmp
  tmp="$(mktemp "$DATA/.env.XXXXXX")"
  if grep -qE "^$1=" "$ENV_FILE"; then
    K="$1" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k"=")==1 {print k"="v; next} {print}' \
      "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}
new_secret() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"; }

step "Writing $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  info "kept the existing file (delete it and re-run to start over)"
  if [ "$WEB_FROM_ARG" -eq 1 ] && [ "$DRY" -eq 0 ]; then
    set_env WEB_DIST "$WEB_DIST"
    info "WEB_DIST now $WEB_DIST"
  fi
elif [ "$DRY" -eq 1 ]; then
  info "[dry-run] copies deploy/pocket/.env.pocket.example there with new secrets, the callsign and the paths"
else
  if [ -z "$CALL" ] && [ -t 0 ]; then
    read -rp "    Your callsign (e.g. OE8APR): " CALL || true
  fi
  CALL="$(printf '%s' "$CALL" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
  if ! printf '%s' "$CALL" | grep -Eq '^[A-Z0-9]{3,7}$' || ! printf '%s' "$CALL" | grep -q '[0-9]'; then
    die "a callsign is required: your base call without SSID, e.g. --call OE8APR (got '${CALL}')."
  fi
  (
    umask 077
    mkdir -p "$DATA"
    cp "$DIR/deploy/pocket/.env.pocket.example" "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
  ingest_secret="$(new_secret)"
  operator_secret="$(new_secret)"
  while [ "$operator_secret" = "$ingest_secret" ]; do operator_secret="$(new_secret)"; done
  set_env PORT "$PORT"
  set_env APP_URL "http://localhost:$PORT"
  set_env INGEST_URL "http://127.0.0.1:$PORT/ingest"
  set_env DB_PATH "$DATA/aprscaching.db"
  set_env MEDIA_DIR "$DATA/media"
  set_env WEB_DIST "$WEB_DIST"
  set_env ADMIN_CALLSIGNS "$CALL"
  set_env APRSIS_CALLSIGN "$CALL"
  set_env INGEST_SECRET "$ingest_secret"
  set_env OPERATOR_SECRET "$operator_secret"
  info "callsign $CALL, port $PORT, ingest and operator secrets generated"
fi

# ---- 10. first start: migrations ---------------------------------------------------------------------
# The gateway applies db/migrations at every start, so starting it once and stopping it migrates the
# database and proves the whole chain (secrets, SQLite, web build) before the station goes out.
step "Starting the gateway once to apply the migrations"
if [ "$DRY" -eq 1 ]; then
  run node --import tsx src/server.ts
  info "[dry-run] waits for /health and / on the configured port, then stops it"
else
  env_port="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  env_port="${env_port:-8787}"
  base="http://127.0.0.1:$env_port"
  if curl -fsS -o /dev/null --max-time 3 "$base/health" 2>/dev/null; then
    info "a gateway already answers on $base; restart it to apply new migrations"
  else
    mkdir -p "$LOG_DIR"
    log="$LOG_DIR/install-boot.log"
    (
      set -a
      # shellcheck disable=SC1090 # the operator's own .env
      . "$ENV_FILE"
      set +a
      cd "$DIR/servers/node"
      exec node --import tsx src/server.ts
    ) >"$log" 2>&1 &
    gw_pid=$!
    healthy=0
    for _ in $(seq 1 120); do
      if curl -fsS -o /dev/null --max-time 2 "$base/health" 2>/dev/null; then
        healthy=1
        break
      fi
      kill -0 "$gw_pid" 2>/dev/null || break
      sleep 1
    done
    web_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/" 2>/dev/null || true)"
    kill -TERM "$gw_pid" 2>/dev/null || true
    wait "$gw_pid" 2>/dev/null || true
    if [ "$healthy" -ne 1 ]; then
      tail -n 20 "$log" >&2
      die "the gateway did not become healthy on $base (log: $log)."
    fi
    grep -E '^migrations' "$log" | sed 's/^/    /' || true
    if [ "$web_status" = "200" ]; then
      info "gateway healthy; the web app answers on /"
    else
      info "gateway healthy, but / answered HTTP $web_status: check WEB_DIST in $ENV_FILE"
    fi
  fi
fi

# ---- 11. next steps ----------------------------------------------------------------------------------
[ "$NEXT_STEPS" -eq 1 ] || exit 0
# The port the .env names: a kept .env may differ from --port.
shown_port="$( { grep -E '^PORT=' "$ENV_FILE" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-)"
PORT="${shown_port:-$PORT}"
cat <<EOF

Done. Next steps:
  1. Start the station: the gateway and the ingest in the tmux session "aprscaching", each restarted
     when it exits, with a wake lock (Ctrl-b d leaves the session running; stop.sh stops it):
       bash $DIR/deploy/pocket/start.sh
     Without a MeshCom node or APRS-IS, add --gateway-only. status.sh shows the processes, the URLs
     other devices use (the hotspot included), storage and the battery.
  2. Open http://localhost:$PORT in Chrome on this phone and sign in (a passkey works on localhost).
     Without one, mint a one-time link:
       bash $DIR/deploy/pocket/signin-link.sh ${CALL:-<CALL>}
  3. Exempt Termux from battery optimisation in Android's settings, and back the station up with
       bash $DIR/deploy/pocket/backup.sh      (after termux-setup-storage)
EOF
