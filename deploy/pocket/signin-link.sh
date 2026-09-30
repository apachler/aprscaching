#!/usr/bin/env bash
# Mint a one-time sign-in link for a callsign on this phone's gateway: the way in when a passkey does
# not work (a browser without passkey support on localhost, no email provider off-grid). It loads
# OPERATOR_SECRET and PORT from ~/.aprscaching/.env and runs tools/admin/signin-link.mjs against
# http://127.0.0.1:<PORT>. The link is single-use and expires in 15 minutes; open it in the browser on
# this phone, or hand it to its owner in person, never over a channel others read.
#
#   bash ~/aprscaching/deploy/pocket/signin-link.sh OE8APR
#
# Options:
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

CALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
    *) CALL="$1" ;;
  esac
  shift
done
pocket_paths
[ -n "$CALL" ] || { pocket_usage "$0" >&2; exit 2; }

env_load
[ -n "${OPERATOR_SECRET:-}" ] || die "OPERATOR_SECRET is empty in $ENV_FILE." \
  "Set one (node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\") and restart the gateway."
BASE="http://127.0.0.1:${PORT:-8787}" exec node "$DIR/tools/admin/signin-link.mjs" "$CALL"
