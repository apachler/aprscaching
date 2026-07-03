#!/usr/bin/env bash
# smoke.sh — deterministic runtime conformance: spin a fresh Node/SQLite gateway on a throwaway DB,
# wait for health, run each runtime-agnostic smoke suite against it (each on its own clean instance so
# there's no cross-suite state), tear down. This automates the start-server / wait / run / kill dance.
#
#   tools/dev/smoke.sh                 # run smoke + geofence
#   tools/dev/smoke.sh smoke           # a single suite
#   SUITES="smoke geofence" tools/dev/smoke.sh
#
# Federation is a TWO-instance e2e (PUB+SUB) — run it separately; this covers the single-instance suites.
set -euo pipefail
cd "$(dirname "$0")/../.."

SUITES="${*:-${SUITES:-smoke geofence}}"
# SR-SEC-01: the gateway refuses to boot on the 'change-me' default — generate a per-run secret.
SECRET="${INGEST_SECRET:-smoke-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')}"
fail=0

run_suite() {
  local suite="$1" port db log pid i rc=0
  port=$(( 8850 + (RANDOM % 120) ))
  db="$(mktemp -u)-${suite}.db"
  log="$(mktemp)"
  # start in its own process group so we can reap pnpm AND its node/tsx children on teardown
  setsid env DB_PATH="$db" INGEST_SECRET="$SECRET" PORT="$port" \
    pnpm --filter @aprsweb/node-gateway start >"$log" 2>&1 &
  pid=$!
  # wait for /health (up to ~20s)
  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "✗ ${suite}: server died on boot"; tail -5 "$log"; return 1; fi
    sleep 0.5
  done
  echo "== ${suite} (:${port}) =="
  if BASE="http://127.0.0.1:${port}" INGEST_SECRET="$SECRET" node "tools/smoke/${suite}.mjs"; then
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
  if [[ ! -f "tools/smoke/${s}.mjs" ]]; then echo "✗ unknown suite '${s}'"; fail=1; continue; fi
  run_suite "$s" || fail=1
done

if [[ $fail -eq 0 ]]; then echo "✓ smoke passed ($SUITES)"; else echo "✗ smoke FAILED"; fi
exit $fail
