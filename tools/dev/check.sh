#!/usr/bin/env bash
# check.sh — the fast inner-loop gate: typecheck/build every package + run every unit suite.
# Deterministic, no servers. Use this after any code change. Exits non-zero on the first failure.
#
#   tools/dev/check.sh            # build + test everything
#   tools/dev/check.sh --build    # build (typecheck) only
#   tools/dev/check.sh --test     # unit tests only
set -euo pipefail
cd "$(dirname "$0")/../.."

mode="${1:-all}"
run() { echo "→ $*"; "$@"; }

if [[ "$mode" == "all" || "$mode" == "--build" ]]; then
  echo "== build (typecheck all units) =="
  run pnpm -r build
fi
if [[ "$mode" == "all" || "$mode" == "--test" ]]; then
  echo "== unit tests (all packages) =="
  run pnpm -r test
fi

# apps/web is in `pnpm -r` like every other unit: its build typechecks before vite, and its guards
# (no raw emoji in rendered UI, tour anchors resolve) run as its test script.

echo "✓ check passed"
