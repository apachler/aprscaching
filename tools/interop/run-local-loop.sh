#!/usr/bin/env bash
# Two-stack AXUDP interop loop: gateway+ingest A <-> gateway+ingest B, then the assertions in
# local-loop.mjs (NODES both ways, an FBB forwarding session A->B, and A pulling B's federation feed over an
# AX.25 circuit). Runs anywhere Node runs —
# no Docker, no kernel AX.25. CI runs this before the containerized peers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export INGEST_SECRET="${INGEST_SECRET:-interop-local-secret-01}"
export OPERATOR_SECRET="${OPERATOR_SECRET:-interop-local-operator-01}"
# A stale gateway on the loop ports would silently serve old code/state to the assertions —
# refuse to run rather than test the wrong thing.
for port in 9601 9602; do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "port $port is already serving — kill the stale stack first"; exit 2
  fi
done
DBA="$(mktemp -d)/a.db"
DBB="$(mktemp -d)/b.db"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill -9 "-$p" 2>/dev/null || kill -9 "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# APRS-IS is pointed at a dead local port: the interop loop is about the AXUDP leg, and CI/network
# sandboxes must not spend 30 s per reconnect on an unreachable public server.
COMMON="APRSIS_HOST=127.0.0.1 APRSIS_PORT=1 BATCH_MS=500"
# Each BBS issues BIDs under its sysop's call (ADMIN_CALLSIGNS): two BBSes on one call would take each
# other's mail for their own.

# FED_BBS=1 runs the loop with federation over FBB on at both stacks (local-loop.mjs then marks each side's
# partner for it and sends a signed batch A->B); unset, it checks that nothing federation-related moves.
export FED_BBS="${FED_BBS:-0}"
FED_KEY_A=''
if [ "$FED_BBS" = 1 ]; then FED_KEY_A="$(node "$ROOT/tools/fedkey/genkey.mjs" --raw)"; fi
# Federation over a packet circuit: B signs its feed and publishes an ax25 endpoint, its ingest answers
# pull-sync on OE1BBB-9; A's ingest dials it as OE1AAA-9. A never pulls over http (FED_SYNC_INTERVAL_MS=0), so
# B's records can only reach A over the AX.25 circuit. FED_ALLOW_PRIVATE lets A look B up on loopback.
FED_KEY_B="$(node "$ROOT/tools/fedkey/genkey.mjs" --raw)"
FED_ENDPOINTS_B='[{"transport":"ax25","address":"OE1BBB-9","priority":10}]'

setsid env DB_PATH="$DBA" PORT=9601 INSTANCE=oe.ia ADMIN_CALLSIGNS=OE1AAA INGEST_SECRET="$INGEST_SECRET" OPERATOR_SECRET="$OPERATOR_SECRET" FED_PRIVATE_KEY="$FED_KEY_A" FED_BBS="$FED_BBS" \
  FED_SYNC_INTERVAL_MS=0 FED_ALLOW_PRIVATE=1 \
  bash -c "exec pnpm --filter @aprscaching/node-gateway start" >/tmp/interop-gwa.log 2>&1 &
PIDS+=($!)
setsid env DB_PATH="$DBB" PORT=9602 INSTANCE=oe.ib ADMIN_CALLSIGNS=OE1BBB INGEST_SECRET="$INGEST_SECRET" OPERATOR_SECRET="$OPERATOR_SECRET" FED_PRIVATE_KEY="$FED_KEY_B" FED_BBS="$FED_BBS" \
  FED_ENDPOINTS="$FED_ENDPOINTS_B" \
  bash -c "exec pnpm --filter @aprscaching/node-gateway start" >/tmp/interop-gwb.log 2>&1 &
PIDS+=($!)
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:9601/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:9602/health >/dev/null 2>&1 && break
  sleep 0.5
done

# Both nodes speak INP3 (NETROM_INP3) alongside NODES, so the triggered RIF / L3RTT path is exercised
# live. LZHUF-B1 compressed forwarding is covered by unit tests; this ASCII gate can only negotiate
# compression back to ASCII, and the fbb interop job forwards uncompressed.
setsid env $COMMON INGEST_URL=http://127.0.0.1:9601/ingest INGEST_SECRET="$INGEST_SECRET" \
  AXUDP_PORT=10501 AXUDP_PEERS=127.0.0.1:10502 \
  NETROM_CALL=OE1AAA-7 NETROM_ALIAS=ACSA NETROM_BROADCAST_MS=3000 NETROM_INP3=1 \
  BBS_NODE_CALL=OE1AAA-1 BBS_FORWARD=1 BBS_FORWARD_CALL=OE1AAA-1 BBS_FORWARD_POLL_MS=3000 \
  FED_LINK_PULL=1 FED_LINK_CALL=OE1AAA-9 FED_LINK_PULL_MS=60000 \
  bash -c "exec pnpm --filter @aprscaching/ingest start" >/tmp/interop-ina.log 2>&1 &
PIDS+=($!)
setsid env $COMMON INGEST_URL=http://127.0.0.1:9602/ingest INGEST_SECRET="$INGEST_SECRET" \
  AXUDP_PORT=10502 AXUDP_PEERS=127.0.0.1:10501 \
  NETROM_CALL=OE1BBB-7 NETROM_ALIAS=ACSB NETROM_BROADCAST_MS=3000 NETROM_INP3=1 \
  BBS_NODE_CALL=OE1BBB-1 FED_LINK_SERVE=1 FED_LINK_CALL=OE1BBB-9 \
  bash -c "exec pnpm --filter @aprscaching/ingest start" >/tmp/interop-inb.log 2>&1 &
PIDS+=($!)
sleep 3

A=http://127.0.0.1:9601 B=http://127.0.0.1:9602 node "$HERE/local-loop.mjs"

# INP3 live check: both nodes discover each other as neighbours (off NODES) and exchange RIFs, so each
# logs an INP3 route learned from the other. Poll the ingest logs — RIF exchange follows NODES discovery.
echo "checking INP3 convergence (RIF learning) on both nodes…"
inp3_ok=0
for _ in $(seq 1 30); do
  if grep -q "\[inp3\] learned" /tmp/interop-ina.log 2>/dev/null && grep -q "\[inp3\] learned" /tmp/interop-inb.log 2>/dev/null; then
    inp3_ok=1; break
  fi
  sleep 1
done
if [ "$inp3_ok" = 1 ]; then
  echo "OK  INP3: both nodes learned a route over triggered RIFs"
else
  echo "FAIL INP3: no '[inp3] learned' on both nodes"
  echo "--- ina inp3 ---"; grep -i inp3 /tmp/interop-ina.log 2>/dev/null | tail -5 || true
  echo "--- inb inp3 ---"; grep -i inp3 /tmp/interop-inb.log 2>/dev/null | tail -5 || true
  exit 1
fi
