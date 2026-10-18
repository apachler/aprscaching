#!/usr/bin/env bash
# Checks of what the Self-host stack's Caddy serves from the web build, and of how the webdist one-shot
# publishes a new build into the volume Caddy serves, both run in the stack's own images (Docker required):
# a missing asset is a 404 and never index.html, the shell revalidates and the hashed assets cache for good,
# every file carries the page headers the Node server and the desktop app send (derived from
# workers/gateway/src/pageheaders.ts), HSTS goes out on https only, and a new build leaves the previous
# build's assets in place for the pages still open on them.
#
#   bash deploy/test/caddy-serve-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$DEPLOY/.." && pwd)"
command -v docker >/dev/null || { echo "FAIL docker is not installed: nothing checked"; exit 1; }

TMP="$(mktemp -d)"
NAME="acs-caddy-serve-test-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # the containers write as their own users; clear the tree from inside one
  docker run --rm -v "$TMP:/t" --entrypoint sh "$CADDY_IMAGE" -c 'rm -rf /t/*' >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
FAILED=0
CHECKED=0
ok() { printf 'ok   %s\n' "$1"; }
bad() {
  printf 'FAIL %s\n' "$1"
  FAILED=1
}
check() { # check "name" command…
  local name="$1"
  shift
  CHECKED=$((CHECKED + 1))
  if "$@"; then ok "$name"; else bad "$name"; fi
}

# The stack's own definitions: the images, the webdist command and the Caddyfile, as compose resolves them.
CONFIG="$(docker compose -f "$DEPLOY/docker-compose.yml" config --no-interpolate --format json)"
svc() { node -e 'const c=JSON.parse(process.argv[1]).services[process.argv[2]]; console.log(JSON.stringify(c))' "$CONFIG" "$1"; }
CADDY_IMAGE="$(node -e 'console.log(JSON.parse(process.argv[1]).image)' "$(svc caddy)")"
WEBDIST_CMD="$(node -e 'const c=JSON.parse(process.argv[1]).command; if (c[0]!=="sh"||c[1]!=="-c") process.exit(1); console.log(c[2])' "$(svc webdist)")"
trap cleanup EXIT
docker pull -q "$CADDY_IMAGE" >/dev/null

# Header name → value, one per line, from the gateway's module.
PAGE_HEADERS="$(cd "$ROOT" && node -e 'import("./workers/gateway/src/pageheaders.ts").then((m) => { for (const [k, v] of Object.entries(m.PAGE_HEADERS)) console.log(`${k}\t${v}`); })')"
[ -n "$PAGE_HEADERS" ] || { echo "FAIL no page headers read from pageheaders.ts: nothing checked"; exit 1; }

# ---- webdist: publishing a new build over the previous one ----------------------------------------------
# The command runs in a Debian image like the stack's (GNU cp, tar and find), on a fake build and volume.
mkdir -p "$TMP/dist/assets" "$TMP/web/assets"
printf '<!doctype html><title>new</title>' >"$TMP/dist/index.html"
printf 'self.addEventListener("fetch",()=>{})' >"$TMP/dist/sw.js"
printf 'export const v = 2' >"$TMP/dist/assets/index-new222.js"
printf '<!doctype html><title>old</title>' >"$TMP/web/index.html"
printf 'export const v = 1' >"$TMP/web/assets/index-old111.js"
printf 'export const v = 0' >"$TMP/web/assets/index-ancient000.js"
touch -d '30 days ago' "$TMP/web/assets/index-ancient000.js"
chmod -R a+rwX "$TMP"
docker run --rm -v "$TMP/dist:/app/apps/web/dist:ro" -v "$TMP/web:/srv/web" --entrypoint sh debian:bookworm-slim \
  -c "$WEBDIST_CMD"
check "webdist publishes the new shell" grep -q '<title>new</title>' "$TMP/web/index.html"
check "  … and the new build's assets" test -f "$TMP/web/assets/index-new222.js"
check "  … and the files beside the shell" test -f "$TMP/web/sw.js"
check "  … and keeps the previous build's assets for the pages still open on them" test -f "$TMP/web/assets/index-old111.js"
check "  … and prunes assets no build has named for weeks" test ! -e "$TMP/web/assets/index-ancient000.js"
check "  … and leaves no staging file behind" bash -c "! ls -A '$TMP/web' | grep -q '^\.'"

# ---- Caddy serving the build ----------------------------------------------------------------------------
docker run -d --name "$NAME" -e DOMAIN=:80 -e EXTRA_SITES=https://localhost \
  -p 127.0.0.1::80 -p 127.0.0.1::443 \
  -v "$DEPLOY/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$TMP/web:/srv/web:ro" \
  "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
HTTP="http://127.0.0.1:$(docker port "$NAME" 80/tcp | head -n1 | sed 's/.*://')"
HTTPS_PORT="$(docker port "$NAME" 443/tcp | head -n1 | sed 's/.*://')"
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null --max-time 2 "$HTTP/" 2>/dev/null && break
  sleep 0.25
done
curl -fsS -o /dev/null --max-time 5 "$HTTP/" || { docker logs "$NAME" | tail -n 20; echo "FAIL Caddy did not answer"; exit 1; }

head_of() { curl -sS -o /dev/null -D - --max-time 5 "$@" | tr -d '\r'; }
status_of() { head -n1 <<<"$1" | awk '{print $2}'; }
header_of() { awk -v k="$2" 'BEGIN{IGNORECASE=1} tolower($0) ~ "^"tolower(k)":" {sub(/^[^:]*: */,""); print; exit}' <<<"$1"; }
eq() { [ "$1" = "$2" ] || { printf '     got: %s\n     want: %s\n' "$1" "$2"; return 1; }; }
has_page_headers() { # has_page_headers HEAD
  local k v miss=""
  while IFS=$'\t' read -r k v; do [ "$(header_of "$1" "$k")" = "$v" ] || miss="$miss $k"; done <<<"$PAGE_HEADERS"
  eq "${miss:-none}" none
}

H="$(head_of "$HTTP/")"
check "/ is the shell" eq "$(status_of "$H")" 200
check "  … revalidated on every load" eq "$(header_of "$H" cache-control)" no-cache
check "  … with the page headers" has_page_headers "$H"
check "  … and no HSTS over plain http" eq "$(header_of "$H" strict-transport-security)" ""
H="$(head_of "$HTTP/cache/AC1234")"
check "a client-side route is the shell" eq "$(header_of "$H" content-type)" "text/html; charset=utf-8"
H="$(head_of "$HTTP/assets/index-new222.js")"
check "a hashed asset is served" eq "$(status_of "$H")" 200
check "  … cached for good" eq "$(header_of "$H" cache-control)" "public, max-age=31536000, immutable"
check "  … with the page headers" has_page_headers "$H"
H="$(head_of "$HTTP/sw.js")"
check "the service worker revalidates" eq "$(header_of "$H" cache-control)" no-cache
H="$(head_of "$HTTP/assets/index-gone999.js")"
check "a missing asset is a 404" eq "$(status_of "$H")" 404
check "  … not the shell" bash -c '[[ "$1" != text/html* ]]' _ "$(header_of "$H" content-type)"
check "  … and not cached for good" bash -c '[[ "$1" != *immutable* ]]' _ "$(header_of "$H" cache-control)"
H="$(head_of "$HTTP/gone.js")"
check "a missing file outside /assets/ is a 404 too" eq "$(status_of "$H")" 404
H="$(head_of -k --resolve "localhost:$HTTPS_PORT:127.0.0.1" "https://localhost:$HTTPS_PORT/")"
check "an https site sends HSTS" eq "$(header_of "$H" strict-transport-security)" "max-age=31536000"
check "  … with the page headers" has_page_headers "$H"

[ "$CHECKED" -gt 0 ] || { echo "FAIL no checks ran"; exit 1; }
[ "$FAILED" = 0 ] || exit 1
echo "all $CHECKED Caddy and webdist checks passed"
