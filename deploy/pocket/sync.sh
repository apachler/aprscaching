#!/usr/bin/env bash
# Sync this phone's station with the federation now: pull from its peers and push to its home hub at once,
# instead of waiting for the next interval. Use it when the phone is back online after a trip; the station
# also notices on its own (it probes the hub after a failed push). Loads OPERATOR_SECRET and PORT from
# ~/.aprscaching/.env and asks the gateway at http://127.0.0.1:<PORT>, then shows how pushing stands.
#
#   bash ~/aprscaching/deploy/pocket/sync.sh
#
# Options:
#   --status             show how pushing stands, without starting a sync
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --status) START=0 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

[ -n "$(env_get OPERATOR_SECRET)" ] || die "OPERATOR_SECRET is not set in $ENV_FILE." "Run install.sh again to add one."
health_ok "$(gateway_base)" || die "The station is not answering on $(gateway_base)." "Start it: bash $DIR/deploy/pocket/start.sh"
[ -n "$(env_get FED_HUB_URL)$(env_get FED_PEERS)" ] || info "no FED_HUB_URL or FED_PEERS: this station syncs with nobody"

if [ "$START" -eq 1 ]; then
  fed_sync POST >/dev/null || die "The gateway refused the sync." "Check OPERATOR_SECRET in $ENV_FILE."
  info "sync started; waiting a few seconds for it"
  sleep 5
fi
fed_sync_lines || true
