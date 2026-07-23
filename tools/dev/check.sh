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

# web has no vitest suite — typecheck + production build are its gate
if [[ "$mode" == "all" || "$mode" == "--build" ]]; then
  echo "== web typecheck + build =="
  run pnpm --filter @aprscaching/web typecheck
  run pnpm --filter @aprscaching/web build
fi

echo "✓ check passed"
