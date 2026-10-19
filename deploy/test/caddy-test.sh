#!/usr/bin/env bash
# Checks of deploy/Caddyfile in the Caddy image the stack runs: a client's cf-connecting-ip reaches the gateway
# only from CF_RANGES. A stand-in gateway (Caddy answering with the header it got) sits behind the real
# Caddyfile on a Docker network of its own; a client container sends the header.
#
#   bash deploy/test/caddy-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
command -v docker >/dev/null && docker info >/dev/null 2>&1 || {
  echo "caddy-test: needs a running Docker" >&2
  exit 1
}

IMAGE="$(sed -n -E 's/^ +image: *(caddy:[^ ]+)$/\1/p' "$DEPLOY/docker-compose.yml")"
[ -n "$IMAGE" ] || {
  echo "caddy-test: no caddy image in deploy/docker-compose.yml" >&2
  exit 1
}
NET="aprscaching-caddy-test-$$"
TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "$NET-gateway" "$NET-caddy" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
FAILED=0
CHECKS=0
check() { # check NAME GOT WANT
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n     got: %s\n     want: %s\n' "$1" "$2" "$3"
    FAILED=1
  fi
}

docker network create "$NET" >/dev/null
printf ':8080 {\n\trespond "cf=[{header.Cf-Connecting-Ip}]"\n}\n' >"$TMP/gateway.Caddyfile"
chmod 644 "$TMP/gateway.Caddyfile"
docker run -d --name "$NET-gateway" --network "$NET" --network-alias gateway \
  -v "$TMP/gateway.Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null

# seen RANGES: what the gateway gets of a client's cf-connecting-ip through deploy/Caddyfile with CF_RANGES set
# to RANGES ("unset" leaves it out of the environment).
seen() {
  local env=(-e DOMAIN=:80) out=""
  [ "$1" = unset ] || env+=(-e "CF_RANGES=$1")
  docker rm -f "$NET-caddy" >/dev/null 2>&1 || true
  docker run -d --name "$NET-caddy" --network "$NET" "${env[@]}" \
    -v "$DEPLOY/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if out="$(docker run --rm --network "$NET" "$IMAGE" \
      wget -qO- --header 'Cf-Connecting-Ip: 192.0.2.7' "http://$NET-caddy/api/x" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    sleep 0.5
  done
  printf 'no answer (%s)' "$(docker logs "$NET-caddy" 2>&1 | tail -n 3 | tr '\n' ' ')"
}

check "a client outside CF_RANGES cannot name itself in cf-connecting-ip" "$(seen 203.0.113.0/24)" "cf=[]"
check "  … one inside it can (cloudflared on the stack's network, the tunnel's private_ranges)" \
  "$(seen private_ranges)" "cf=[192.0.2.7]"
check "  … and CF_RANGES unset lets every address through, as without Cloudflare" "$(seen unset)" "cf=[192.0.2.7]"

[ "$CHECKS" -gt 0 ] || {
  echo "caddy-test: no checks ran" >&2
  exit 1
}
if [ "$FAILED" -ne 0 ]; then
  echo "caddy checks FAILED"
  exit 1
fi
echo "all $CHECKS caddy checks passed"
