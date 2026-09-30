#!/usr/bin/env bash
# Install and start Pocket inside the termux/termux-docker image, the way the phone does, from a checkout
# mounted at /src: install.sh (Termux packages, better-sqlite3 compiled with Termux's clang, the web
# build, the migrations), start.sh, /health and the SPA, status.sh, tls.sh with https answering, stop.sh.
# The weekly workflow .github/workflows/pocket-termux.yml runs it; on a PC with Docker:
#
#   docker run --rm -v "$PWD:/src:ro" termux/termux-docker:aarch64 bash /src/deploy/pocket/test/termux-ci.sh
#
# Rolldown, the web build's bundler, has native builds for Android on arm64 and 32-bit arm only, which is
# what phones run. On x86_64 the web app is built outside and handed in, the way install.sh's --web-dist
# takes a build copied from a PC: a mounted apps/web/dist as the second argument. (Arguments, not the
# environment: the image's entrypoint starts the command with a clean environment.)
#
#   termux-ci.sh [SRC] [WEB_DIST]
#
# The container has no Android: Termux:API, the wake lock and the phone's networks are absent, so those
# lines of status.sh stay empty. It runs as Termux's unprivileged user, like the app.
set -euo pipefail

SRC="${1:-/src}"
WEB_DIST="${2:-}"
DIR="$HOME/aprscaching"
DATA="$HOME/.aprscaching"
PORT=8787
HTTPS_PORT=8443
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  tail -n 40 "$DATA/logs/gateway.log" 2>/dev/null >&2 || true
  exit 1
}
ok() { printf 'ok    %s\n' "$*"; }

# The Termux app preloads termux-exec, which maps /bin/sh and /usr/bin/env in script shebangs (the pnpm
# bin shims, for one) to Termux's own; the image does not, so set it the way the app does.
if [ -z "${LD_PRELOAD:-}" ]; then
  for lib in libtermux-exec-ld-preload.so libtermux-exec.so; do
    if [ -f "$PREFIX/lib/$lib" ]; then
      export LD_PRELOAD="$PREFIX/lib/$lib"
      break
    fi
  done
fi

# The checkout as the phone has it: a git clone under Termux's home.
command -v git >/dev/null 2>&1 || { apt-get update -q && apt-get install -yq git; }
git config --global --add safe.directory "$SRC"
git config --global --add safe.directory "$SRC/.git"
rm -rf "$DIR"
git clone --quiet "$SRC" "$DIR"
ok "cloned $(git -C "$DIR" rev-parse --short HEAD)"

start=$(date +%s)
web=()
if [ -n "${WEB_DIST:-}" ]; then web=(--web-dist "$WEB_DIST"); fi
if ! bash "$DIR/deploy/pocket/install.sh" --call N0CALL --dir "$DIR" --data-dir "$DATA" --no-update --no-next-steps \
  "${web[@]}"; then
  for log in better-sqlite3-build web-build install-boot; do
    [ -f "$DATA/logs/$log.log" ] || continue
    printf -- '---- %s.log\n' "$log" >&2
    grep -v '^ *at ' "$DATA/logs/$log.log" | tail -n 40 >&2
  done
  fail "install.sh"
fi
ok "install.sh in $(($(date +%s) - start)) s on $(uname -m), node $(node --version)${WEB_DIST:+, web build from $WEB_DIST}"

bash "$DIR/deploy/pocket/start.sh" --no-attach --gateway-only --dir "$DIR" --data-dir "$DATA"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null || fail "/health"
ok "the gateway answers /health"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" | grep -qi "<html" || fail "the web app at /"
ok "the gateway serves the web app"
out="$(bash "$DIR/deploy/pocket/status.sh" --data-dir "$DATA" 2>&1)" || true
grep -q "gateway  running" <<<"$out" || fail "status.sh: $out"
ok "status.sh shows the gateway running"

bash "$DIR/deploy/pocket/tls.sh" --port "$HTTPS_PORT" --dir "$DIR" --data-dir "$DATA"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 --cacert "$DATA/tls/ca.crt" "https://127.0.0.1:$HTTPS_PORT/health" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null --max-time 5 --cacert "$DATA/tls/ca.crt" "https://127.0.0.1:$HTTPS_PORT/health" ||
  fail "https with the station CA"
ok "tls.sh: https answers with the station CA"

bash "$DIR/deploy/pocket/stop.sh" --dir "$DIR" --data-dir "$DATA"
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null; then fail "stop.sh left the gateway"; fi
ok "stop.sh stopped the station"
echo "all Termux checks passed"
