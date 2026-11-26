#!/usr/bin/env bash
# The operator secret never goes to a TCP port: every Pocket script call that sends `x-operator-secret`
# reaches the gateway through its Unix socket (GATEWAY_SOCKET), in Termux's private data directory. On
# Android every app with the INTERNET permission shares loopback and may bind the gateway's TCP port while
# it is free (a restart, the boot delay), so a header sent there goes to whoever holds the port.
#
# A stand-in for that app holds the gateway's TCP port, a stand-in gateway serves the socket, and the
# scripts' own calls run with a dummy secret: the port must see no secret, the socket must see each call.
# A scan of deploy/pocket then finds every place that writes the header. Runs anywhere with bash, curl and
# node; no Termux, no gateway.
#
#   bash deploy/pocket/test/operator-socket-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POCKET="$ROOT/deploy/pocket"
# A short base: a socket path is limited to 107 bytes.
WORK="$(mktemp -d)"
trap 'kill "${LISTENERS:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  FAILS=$((FAILS + 1))
}

SECRET=deadbeefsecret
export APRSCACHING_DATA="$WORK/d" APRSCACHING_DIR="$ROOT"
RUN="$APRSCACHING_DATA/run"
SOCK="$RUN/gateway.sock"
mkdir -p "$RUN"
chmod 700 "$RUN"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
printf 'PORT=%s\nOPERATOR_SECRET=%s\nGATEWAY_SOCKET=%s\n' "$PORT" "$SECRET" "$SOCK" >"$APRSCACHING_DATA/.env"
chmod 600 "$APRSCACHING_DATA/.env"

# The squatter on 127.0.0.1:PORT and the gateway on the socket: each logs the secret header of every request
# as "<listener> <method> <path> <header value>", and answers what the scripts parse.
cat >"$WORK/listeners.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const [port, sock, log] = process.argv.slice(2);
const answer = (name) => (req, res) => {
  fs.appendFileSync(log, `${name} ${req.method} ${req.url} ${req.headers["x-operator-secret"] ?? "-"}\n`);
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ link: "http://localhost/x", account: "new", callsign: "N0CALL", expiresIn: 900,
    hub: null, spokes: [], caches: 0, tombstones: 0, keys: 0, peers: 1, bytes: 1 }));
};
let up = 0;
const ready = () => ++up === 2 && fs.appendFileSync(log, "ready\n");
http.createServer(answer("tcp")).listen(Number(port), "127.0.0.1", ready);
http.createServer(answer("socket")).listen(sock, ready);
JS
: >"$WORK/log"
node "$WORK/listeners.mjs" "$PORT" "$SOCK" "$WORK/log" &
LISTENERS=$!
for _ in $(seq 1 50); do
  grep -q ready "$WORK/log" && break
  sleep 0.1
done
grep -q ready "$WORK/log" || { echo "FAIL the stand-in listeners did not start" >&2; exit 1; }

# The scripts' own calls, each once: lib.sh's helpers (notify.sh, alerts.sh, usb-kiss.sh and status.sh call
# them), sync.sh, extras/sync-now.sh and signin-link.sh.
calls=(
  "station_status|bash -c '. \"$POCKET/lib.sh\"; station_status \"\"'"
  "fed_sync GET|bash -c '. \"$POCKET/lib.sh\"; fed_sync GET'"
  "fed_sync POST|bash -c '. \"$POCKET/lib.sh\"; fed_sync POST'"
  "sync.sh|bash \"$POCKET/sync.sh\""
  "extras/sync-now.sh|bash \"$POCKET/extras/sync-now.sh\" --mobile"
  "signin-link.sh|bash \"$POCKET/signin-link.sh\" N0CALL"
)
for entry in "${calls[@]}"; do
  name="${entry%%|*}"
  before="$(grep -c "^socket .* $SECRET\$" "$WORK/log" || true)"
  eval "${entry#*|}" >"$WORK/out" 2>&1 || true
  after="$(grep -c "^socket .* $SECRET\$" "$WORK/log" || true)"
  if [ "$after" -gt "$before" ]; then
    pass "$name sends the secret through the socket"
  else
    fail "$name: the socket received no x-operator-secret ($(tail -n 1 "$WORK/out"))"
  fi
done

# The socket must have heard the calls, or "nothing on TCP" proves nothing.
heard="$(grep -c "^socket .* $SECRET\$" "$WORK/log" || true)"
if [ "$heard" -ge "${#calls[@]}" ]; then pass "the socket received $heard requests with the secret"; else fail "the socket received $heard requests with the secret, expected ${#calls[@]}"; fi
leaked="$(grep "^tcp " "$WORK/log" | grep -v -- ' -$' || true)"
if [ -z "$leaked" ]; then
  pass "the TCP port received no x-operator-secret ($(grep -c '^tcp ' "$WORK/log" || true) requests, all without it)"
else
  fail "the TCP port received the secret:"
  sed 's/^/       /' <<<"$leaked"
fi

# ---- without GATEWAY_SOCKET the secret is not sent at all, never to TCP instead --------------------------
grep -v '^GATEWAY_SOCKET=' "$APRSCACHING_DATA/.env" >"$WORK/env" && cat "$WORK/env" >"$APRSCACHING_DATA/.env"
: >"$WORK/log"
for entry in "${calls[@]}"; do eval "${entry#*|}" >/dev/null 2>&1 || true; done
leaked="$(grep "^tcp " "$WORK/log" | grep -v -- ' -$' || true)"
if [ -z "$leaked" ]; then pass "without GATEWAY_SOCKET no call sends the secret to TCP"; else
  fail "without GATEWAY_SOCKET the TCP port received the secret:"
  sed 's/^/       /' <<<"$leaked"
fi

# ---- the scan: every place in deploy/pocket that writes the header -------------------------------------
# One helper, lib.sh's operator_curl, writes it, on the same line as its --unix-socket.
mapfile -t senders < <(grep -rn --exclude-dir=test 'x-operator-secret' "$POCKET" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ "${#senders[@]}" -eq 1 ] && [[ ${senders[0]} == "$POCKET/lib.sh:"* ]] && [[ ${senders[0]} == *--unix-socket* ]]; then
  pass "deploy/pocket writes x-operator-secret in one place, beside --unix-socket"
else
  fail "deploy/pocket writes x-operator-secret in ${#senders[@]} places, not only lib.sh's socket call:"
  printf '       %s\n' "${senders[@]#"$ROOT/"}"
fi
# signin-link.mjs takes the socket from GATEWAY_SOCKET; a BASE the script sets would take it to TCP instead.
if grep -nE '^[^#]*BASE=' "$POCKET/signin-link.sh" >/dev/null; then fail "signin-link.sh sets BASE, which sends the secret to that URL"; else pass "signin-link.sh sets no BASE"; fi

# ---- an existing install moves on update -------------------------------------------------------------
# install.sh (which update.sh runs) calls pocket_sockets_env on the kept .env: the gateway's socket is added,
# and a USB TNC's KISS on loopback moves to the bridge's socket. A TNC elsewhere on the LAN stays as it is.
migrate() {
  local data="$WORK/m-$1"
  mkdir -p "$data"
  printf '%s\n' "${@:2}" >"$data/.env"
  APRSCACHING_DATA="$data" bash -c '. "$1/lib.sh"; pocket_sockets_env; pocket_sockets_env' _ "$POCKET" >/dev/null
  # The keys the move touches, in the order they are written.
  grep -E '^(GATEWAY_SOCKET|KISS_TNC_HOST|KISS_TNC_PORT|USB_KISS_DEVICE)=' "$data/.env" | sort | tr '\n' ' '
}
got="$(migrate usb USB_KISS_DEVICE=/dev/bus/usb/001/002 KISS_TNC_HOST=127.0.0.1 KISS_TNC_PORT=8001)"
want="GATEWAY_SOCKET=$WORK/m-usb/run/gateway.sock KISS_TNC_HOST=$WORK/m-usb/run/kiss.sock USB_KISS_DEVICE=/dev/bus/usb/001/002 "
if [ "$got" = "$want" ]; then pass "an older .env with a USB TNC moves to both sockets"; else fail "the USB TNC's .env moved to: $got"; fi
got="$(migrate lan KISS_TNC_HOST=192.168.1.20 KISS_TNC_PORT=8001)"
want="GATEWAY_SOCKET=$WORK/m-lan/run/gateway.sock KISS_TNC_HOST=192.168.1.20 KISS_TNC_PORT=8001 "
if [ "$got" = "$want" ]; then pass "  … a TNC on the LAN keeps its host and port"; else fail "the LAN TNC's .env moved to: $got"; fi
got="$(migrate set GATEWAY_SOCKET=/x/gw.sock)"
if [ "$got" = "GATEWAY_SOCKET=/x/gw.sock " ]; then pass "  … and a GATEWAY_SOCKET already set is kept"; else fail "a set GATEWAY_SOCKET became: $got"; fi
# install.sh runs the move before the gateway's first start, after the .env is written or kept.
if awk '/^# ---- 10\./{exit} /^step "Writing \$ENV_FILE"/{w=1} w && /^[[:space:]]+pocket_sockets_env$/{found=1} END{exit !found}' \
  "$POCKET/install.sh"; then
  pass "install.sh moves the .env to the sockets before the gateway's first start"
else fail "install.sh does not run pocket_sockets_env before the gateway's first start"; fi

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed" >&2
  exit 1
fi
echo "all operator-socket checks passed"
