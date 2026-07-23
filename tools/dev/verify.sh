#!/usr/bin/env bash
# verify.sh — the full pre-commit / final gate: check.sh (build + all unit tests + web build) then
# smoke.sh (runtime conformance on a fresh Node/SQLite gateway). One command to prove a change is green
# across the tri-runtime bar. Exits non-zero on the first failure.
#
#   tools/dev/verify.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "########## 1/2  check (build + unit tests) ##########"
tools/dev/check.sh

echo "########## 2/2  smoke (runtime conformance) ##########"
tools/dev/smoke.sh

echo "✓✓ verify passed — green across packages + Node/SQLite runtime"
