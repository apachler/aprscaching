#!/usr/bin/env bash
# Two-stack AXUDP interop loop: gateway+ingest A <-> gateway+ingest B, then the assertions in
# local-loop.mjs (NODES both ways + an FBB forwarding session A->B). Runs anywhere Node runs —
# no Docker, no kernel AX.25. CI runs this before the containerized peers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export INGEST_SECRET="${INGEST_SECRET:-interop-local-secret-01}"
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

setsid env DB_PATH="$DBA" PORT=9601 INSTANCE=oe.ia INGEST_SECRET="$INGEST_SECRET" FED_PRIVATE_KEY='' \
  bash -c "exec pnpm --filter @aprscaching/node-gateway start" >/tmp/interop-gwa.log 2>&1 &
PIDS+=($!)
setsid env DB_PATH="$DBB" PORT=9602 INSTANCE=oe.ib INGEST_SECRET="$INGEST_SECRET" FED_PRIVATE_KEY='' \
  bash -c "exec pnpm --filter @aprscaching/node-gateway start" >/tmp/interop-gwb.log 2>&1 &
PIDS+=($!)
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:9601/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:9602/health >/dev/null 2>&1 && break
  sleep 0.5
done

# Both nodes speak INP3 (NETROM_INP3) alongside NODES, so the triggered RIF / L3RTT path is exercised
# live. LZHUF-B1 compressed forwarding is validated against the real byte-capable F6FBB peer (the fbb
# interop job, fbbcomp on), not this ASCII gate where compression can only negotiate back to ASCII.
setsid env $COMMON INGEST_URL=http://127.0.0.1:9601/ingest INGEST_SECRET="$INGEST_SECRET" \
  AXUDP_PORT=10501 AXUDP_PEERS=127.0.0.1:10502 \
  NETROM_CALL=OE1AAA-7 NETROM_ALIAS=ACSA NETROM_BROADCAST_MS=3000 NETROM_INP3=1 \
  BBS_NODE_CALL=OE1AAA-1 BBS_FORWARD=1 BBS_FORWARD_CALL=OE1AAA-1 BBS_FORWARD_POLL_MS=3000 \
  bash -c "exec pnpm --filter @aprscaching/ingest start" >/tmp/interop-ina.log 2>&1 &
PIDS+=($!)
setsid env $COMMON INGEST_URL=http://127.0.0.1:9602/ingest INGEST_SECRET="$INGEST_SECRET" \
  AXUDP_PORT=10502 AXUDP_PEERS=127.0.0.1:10501 \
  NETROM_CALL=OE1BBB-7 NETROM_ALIAS=ACSB NETROM_BROADCAST_MS=3000 NETROM_INP3=1 \
  BBS_NODE_CALL=OE1BBB-1 \
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
