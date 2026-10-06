#!/usr/bin/env bash
# Sync before a trip: pull the caches, deletes and keys of the station's federation peers (usually your
# home instance) now, while the phone is on Wi-Fi, so the map is current out in the field without a data
# connection. It asks the local gateway (POST /federation/sync, with the OPERATOR_SECRET) for a narrowed
# pull and reports what arrived and how many bytes it took.
#
#   bash ~/aprscaching/deploy/pocket/extras/sync-now.sh
#   bash ~/aprscaching/deploy/pocket/extras/sync-now.sh --finds --pages 20
#
# The data budget:
#   - caches, deletes (always) and callsign keys; finds only with --finds;
#   - at most --pages pages of 500 records per feed and peer (default 10); a later run carries on;
#   - FED_SYNC_REGION=S,W,N,E in the .env narrows the caches to one area where the peer filters by
#     region (a peer without the filter sends every cache);
#   - on Wi-Fi only: without a joined Wi-Fi network (told by Termux:API) it stops, unless --mobile or
#     POCKET_SYNC_MOBILE=1 allows mobile data.
# With Termux:API, a notification shows the pull and its result. The Termux:Widget shortcut
# "APRScaching Sync before trip" (extras/setup.sh --shortcuts) runs this.
#
# Options:
#   --finds              pull finds too
#   --pages N            pages per feed and peer, 1-50 (default 10)
#   --mobile             allow a pull over mobile data
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

FINDS=0
PAGES=10
MOBILE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --finds) FINDS=1 ;;
    --pages) PAGES="${2:-}"; shift ;;
    --mobile) MOBILE=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
case "$PAGES" in '' | *[!0-9]*) die "--pages takes a number, 1-50 (got '$PAGES')." ;; esac
[ "$PAGES" -ge 1 ] && [ "$PAGES" -le 50 ] || die "--pages takes a number, 1-50 (got '$PAGES')."
[ "$(env_get POCKET_SYNC_MOBILE)" != 1 ] || MOBILE=1

NID=aprscaching-sync
notify() {
  if have termux-notification; then termux_api termux-notification --id "$NID" --title "$1" --content "$2" >/dev/null || true; fi
}

# ---- only on Wi-Fi, unless mobile data is allowed ------------------------------------------------------
wifi_detect
if [ "$MOBILE" -eq 0 ] && [ -z "$WIFI_IP" ]; then
  if [ "$WIFI_KNOWN" -eq 1 ]; then
    die "the phone has not joined a Wi-Fi network, so the pull would use mobile data." \
      "Join a Wi-Fi network, or allow mobile data with --mobile (POCKET_SYNC_MOBILE=1 in the .env)."
  fi
  die "cannot tell Wi-Fi from mobile data without the Termux:API app." \
    "Install it (and pkg install termux-api), or go ahead with --mobile."
fi

base="$(gateway_base)"
health_ok "$base" || die "the gateway does not answer on $base." "Start the station first:  bash $HERE/start.sh"
secret="$(env_get OPERATOR_SECRET)"
[ -n "$secret" ] || die "OPERATOR_SECRET is not set in $ENV_FILE."

types='"cache","key"'
[ "$FINDS" -eq 0 ] || types="$types,\"find\""
region="$(env_get FED_SYNC_REGION)"
step "Sync before the trip${WIFI_SSID:+ (Wi-Fi $WIFI_SSID)}"
info "caches$([ "$FINDS" -eq 1 ] && printf ', finds'), deletes and keys; up to $PAGES pages per feed and peer"
info "region: ${region:-all caches (FED_SYNC_REGION=S,W,N,E in the .env narrows them)}"
notify "APRScaching: syncing" "pulling from the federation peers${WIFI_SSID:+ over $WIFI_SSID}"

started=$(date +%s)
# The header comes from a file descriptor, so the secret never shows in the process list.
if ! out="$(curl -fsS --max-time 900 -X POST -H 'content-type: application/json' \
  -H @<(printf 'x-operator-secret: %s\n' "$secret") \
  --data "{\"types\":[$types],\"maxPages\":$PAGES}" "$base/federation/sync" 2>&1)"; then
  notify "APRScaching: sync failed" "see sync-now.sh in Termux"
  die "the sync request failed: $out"
fi
took=$(($(date +%s) - started))

# shellcheck disable=SC2016 # JavaScript template literals, not shell
summary="$(printf '%s' "$out" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    const size = j.bytes < 1048576 ? `${Math.ceil(j.bytes / 1024)} KB` : `${(j.bytes / 1048576).toFixed(1)} MB`;
    const parts = [`${j.caches} caches`, `${j.tombstones} deletes`, `${j.keys} keys`];
    if (j.finds) parts.push(`${j.finds} finds`);
    process.stdout.write(`${parts.join(", ")} from ${j.peers} peer${j.peers === 1 ? "" : "s"}, ${size}\n`);
    for (const e of j.errors ?? []) process.stdout.write(`error\t${e}\n`);
  });')"
headline="$(printf '%s\n' "$summary" | head -n 1)"
info "$headline in ${took} s"
errors=0
while IFS=$'\t' read -r kind msg; do
  [ "$kind" = error ] || continue
  warn "$msg"
  errors=$((errors + 1))
done <<<"$summary"
mkdir -p "$RUN_DIR"
printf '%s %s\n' "$(date +%s)" "$headline" >"$RUN_DIR/last-sync"

if grep -q "from 0 peers" <<<"$headline"; then
  info "no peers: name your home instance in FED_PEERS (the Pocket guide, Federation)"
fi
if [ "$errors" -gt 0 ]; then
  notify "APRScaching: sync done, $errors peer(s) failed" "$headline"
  exit 1
fi
notify "APRScaching: synced" "$headline"
