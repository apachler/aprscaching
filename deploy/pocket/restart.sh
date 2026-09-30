#!/usr/bin/env bash
# Restart the gateway, the ingest or both in the running station, e.g. after editing the .env by hand or
# after turning the hotspot on for a MeshCom node (the ingest's MeshCom listener binds the phone's
# address on the node's subnet when it starts). Each supervisor restarts its process at once.
#
#   bash ~/aprscaching/deploy/pocket/restart.sh            # both
#   bash ~/aprscaching/deploy/pocket/restart.sh ingest
#
# Options:
#   gateway | ingest     restart only that process
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

WHICH=""
# --dir is accepted like in the other scripts, though this one does not use the checkout.
# shellcheck disable=SC2034
while [ $# -gt 0 ]; do
  case "$1" in
    gateway | ingest) WHICH="$1" ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

step "Restarting"
if [ -n "$WHICH" ]; then
  restart_proc "$WHICH" || die "$WHICH is not running." "Start the station with:  bash $HERE/start.sh"
else
  restart_station || die "the station is not running." "Start it with:  bash $HERE/start.sh"
fi
if [ "$WHICH" != ingest ]; then
  sleep 2
  for _ in $(seq 1 60); do
    health_ok "$(gateway_base)" 2 && break
    sleep 1
  done
  if health_ok "$(gateway_base)" 2; then info "gateway healthy on $(gateway_base)"; else warn "the gateway does not answer yet; see status.sh"; fi
fi
