#!/usr/bin/env bash
# smoke.sh — deterministic runtime conformance: spin a fresh Node/SQLite gateway on a throwaway DB,
# wait for health, run each runtime-agnostic smoke suite against it (each on its own clean instance so
# there's no cross-suite state), tear down. This automates the start-server / wait / run / kill dance.
#
#   tools/dev/smoke.sh                 # run smoke + geofence
#   tools/dev/smoke.sh smoke           # a single suite
#   tools/dev/smoke.sh federation      # the two-instance federation e2e (publisher + subscriber)
#   SUITES="smoke geofence" tools/dev/smoke.sh
#
# `federation` boots a publisher and a subscriber on free ports with the environment of the CI
# conformance-federation job (signing keys, key history, a signed registry, relay/submit secrets).
set -euo pipefail
cd "$(dirname "$0")/../.."

SUITES="${*:-${SUITES:-smoke geofence}}"
# The gateway refuses to boot on the 'change-me' default secret — generate per-run ingest, operator and
# session secrets (the smoke client needs the first two; the third keeps the gateway from writing a
# session.secret file beside the throwaway database).
SECRET="${INGEST_SECRET:-smoke-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')}"
OPSECRET="${OPERATOR_SECRET:-smoke-op-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')}"
SESSECRET="${SESSION_SECRET:-smoke-sess-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')}"
# Tier A is default-deny: it requires the operator to attest their own receiving sites. The smoke
# suite gates its RF fixes through OE8XXX, so name it here for the conformance run to reach Tier A.
FIRST_PARTY_SITES="${FIRST_PARTY_SITES:-OE8XXX}"
fail=0

# A free TCP port on 127.0.0.1 (the kernel picks one; nothing holds it once this returns).
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'; }

# Wait for a gateway's /health; fail early if its process died.
wait_health() {
  local port="$1" pid="$2" log="$3" i
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "✗ gateway on :${port} died on boot"; tail -5 "$log"; return 1; fi
    sleep 0.5
  done
  echo "✗ gateway on :${port} never became healthy"; tail -5 "$log"; return 1
}

run_federation() {
  local pubport subport tmp key subkey pubpub pubfp pub2 pub3 hist reg registry registry_key ppid spid rc=0
  pubport=$(free_port); subport=$(free_port)
  while [[ "$subport" == "$pubport" ]]; do subport=$(free_port); done
  tmp="$(mktemp -d)"
  pubkey() { node -e "process.stdout.write(JSON.parse(Buffer.from(process.argv[1],'base64')).pub)" "$1"; }
  key=$(node tools/fedkey/genkey.mjs --raw)
  subkey=$(node tools/fedkey/genkey.mjs --raw) # corroboration questions are signed
  pubpub=$(pubkey "$key")
  # the subscriber pins the publisher's key fingerprint in FED_PEERS, so the publisher starts trusted there
  pubfp=$(node tools/fedkey/fingerprint.mjs "$pubpub" --raw)
  pub2=$(pubkey "$(node tools/fedkey/genkey.mjs --raw)")
  pub3=$(pubkey "$(node tools/fedkey/genkey.mjs --raw)")
  hist="[{\"x\":\"$pub2\",\"since\":1},{\"x\":\"$pub3\",\"since\":1,\"revoked\":true}]"
  reg=$(node tools/fedkey/signregistry.mjs "[{\"instance\":\"oe.pub\",\"url\":\"http://127.0.0.1:${pubport}\",\"key\":\"$pubpub\",\"operator\":\"OE8APR\"}]" --raw)
  registry=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).FED_REGISTRY)" "$reg")
  registry_key=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).FED_REGISTRY_KEY)" "$reg")
  local common=(INGEST_SECRET="$SECRET" OPERATOR_SECRET="$OPSECRET" SESSION_SECRET="$SESSECRET" ALLOW_DEV_TOKENS=1)
  # The publisher attests OE8XXX, the IGate its RF fix comes through, so it may corroborate for peers, and
  # FED_ALLOW_PRIVATE lets it add the subscriber, on loopback, by address.
  setsid env "${common[@]}" DB_PATH="$tmp/pub.db" PORT="$pubport" INSTANCE=oe.pub FED_PRIVATE_KEY="$key" \
    FED_KEY_HISTORY="$hist" FIRST_PARTY_SITES=OE8XXX FED_OPERATOR=OE8APR SERVICE_CALL=OE8APR-12 \
    FED_RELAY_SECRET=relaysecret FED_ALLOW_PRIVATE=1 \
    FED_ENDPOINTS="[{\"transport\":\"https\",\"address\":\"http://127.0.0.1:${pubport}\",\"priority\":10}]" \
    pnpm --filter @aprscaching/node-gateway start >"$tmp/pub.log" 2>&1 &
  ppid=$!
  # A two-instance network has one corroborating peer, so the subscriber accepts a quorum of one.
  setsid env "${common[@]}" DB_PATH="$tmp/sub.db" PORT="$subport" INSTANCE=oe.sub FED_PRIVATE_KEY="$subkey" \
    FED_PEERS="http://127.0.0.1:${pubport}#${pubfp}" FED_CORROBORATION_QUORUM=1 FED_SUBMIT_SECRET=submitsecret \
    FED_RELAY_SECRET=relaysecret FED_REGISTRY="$registry" FED_REGISTRY_KEY="$registry_key" \
    pnpm --filter @aprscaching/node-gateway start >"$tmp/sub.log" 2>&1 &
  spid=$!
  if wait_health "$pubport" "$ppid" "$tmp/pub.log" && wait_health "$subport" "$spid" "$tmp/sub.log"; then
    echo "== federation (pub :${pubport}, sub :${subport}) =="
    if ! PUB="http://127.0.0.1:${pubport}" SUB="http://127.0.0.1:${subport}" RELAY_SECRET=relaysecret \
      INGEST_SECRET="$SECRET" OPERATOR_SECRET="$OPSECRET" node tools/smoke/federation.mjs; then
      rc=1; echo "--- publisher log tail ---"; tail -8 "$tmp/pub.log"; echo "--- subscriber log tail ---"; tail -8 "$tmp/sub.log"
    fi
  else
    rc=1
  fi
  kill -- -"$ppid" -"$spid" 2>/dev/null || kill "$ppid" "$spid" 2>/dev/null || true
  wait "$ppid" "$spid" 2>/dev/null || true
  rm -rf "$tmp"
  return $rc
}

run_suite() {
  local suite="$1" port db log pid i rc=0
  port=$(( 8850 + (RANDOM % 120) ))
  db="$(mktemp -u)-${suite}.db"
  log="$(mktemp)"
  # start in its own process group so we can reap pnpm AND its node/tsx children on teardown
  setsid env DB_PATH="$db" INGEST_SECRET="$SECRET" OPERATOR_SECRET="$OPSECRET" SESSION_SECRET="$SESSECRET" \
    PORT="$port" ALLOW_DEV_TOKENS=1 \
    FIRST_PARTY_SITES="$FIRST_PARTY_SITES" \
    pnpm --filter @aprscaching/node-gateway start >"$log" 2>&1 &
  pid=$!
  # wait for /health (up to ~20s)
  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "✗ ${suite}: server died on boot"; tail -5 "$log"; return 1; fi
    sleep 0.5
  done
  echo "== ${suite} (:${port}) =="
  if BASE="http://127.0.0.1:${port}" INGEST_SECRET="$SECRET" OPERATOR_SECRET="$OPSECRET" node "tools/smoke/${suite}.mjs"; then
    rc=0
  else
    rc=1; echo "--- server log tail ---"; tail -8 "$log"
  fi
  kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true   # reap the whole process group
  wait "$pid" 2>/dev/null || true
  rm -f "$db" "$log"
  return $rc
}

for s in $SUITES; do
  if [[ "$s" == federation ]]; then run_federation || fail=1; continue; fi
  if [[ ! -f "tools/smoke/${s}.mjs" ]]; then echo "✗ unknown suite '${s}'"; fail=1; continue; fi
  run_suite "$s" || fail=1
done

if [[ $fail -eq 0 ]]; then echo "✓ smoke passed ($SUITES)"; else echo "✗ smoke FAILED"; fi
exit $fail
