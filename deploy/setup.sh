#!/usr/bin/env bash
# First-run wizard for the Docker stack: writes deploy/.env with everything a working instance needs —
# the operator's call (ADMIN_CALLSIGNS), the public URL (APP_URL; INSTANCE and RP_ID follow its host),
# the APRS-IS feed, the ingest and operator secrets, the federation signing key, and the receiving-site
# call of an RF receiver you operate (RF_SITE_CALL on the ingest box, FIRST_PARTY_SITES on the gateway).
#
# Safe to re-run: a value already in .env is kept unless you confirm the change (or pass --yes), and a
# secret already set is never regenerated — rotating one signs users out or cuts the ingest box off.
#
#   ./setup.sh                                   # interactive
#   ./setup.sh --non-interactive --call OE8APR --passcode 12345 --filter r/47.07/15.42/300 \
#              --domain aprs.example.net [--tunnel-token …] [--site-call OE8APR-10]
#   ./setup.sh --non-interactive --call OE8APR --lan-host 192.168.1.10     # LAN / off-grid, plain http
#
# A public instance gets the safe federation posture: auto-promotion off and a corroboration quorum of 2
# written out, discovery off (FED_DISCOVER=0), only the peers you name, never a
# 44Net peer as trusted, an explicit spoke list on a hub and a pinned key for any registry. A LAN instance
# starts with federation off. The D1 write budget is written off: SQLite costs the same whatever it writes.
#
# Options: --env-file PATH (default ./.env) · --no-network (skip the APRS-IS reachability check) ·
#          --yes (replace existing values without asking) · --app-port PORT (the LAN URL's port, when the
#          gateway answers on its own port rather than through Caddy) · --no-tunnel (offer no Cloudflare
#          Tunnel: the installer has no compose stack to run one) · --no-next-steps (the caller prints its
#          own) · --help
# Federation (public instances): --fed-peers URL,… (https peers you know; they start trusted) ·
#          --fed-submit-instances ID,… (required on a hub, FED_SUBMIT_SECRET set) ·
#          --fed-registry-key KEY (required with FED_REGISTRY/FED_REGISTRY_DNS) ·
#          --net44-name NAME (this instance's 44Net name, e.g. aprscaching.oe8apr.ampr.org)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ENV_FILE="$HERE/.env"
INTERACTIVE=1
NETWORK=1
ASSUME_YES=0
CALL="" PASS="" FILTER="" DOMAIN_IN="" LAN_HOST="" TUNNEL="" SITE="" SITE_SET=0 APP_PORT="" NO_TUNNEL=0 NEXT_STEPS=1
FED_PEERS_IN="" FED_PEERS_SET=0 FED_SUBMIT_IN="" FED_REGKEY_IN="" NET44_IN="" NET44_SET=0

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/, ""); print; next} {exit}' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) INTERACTIVE=0 ;;
    --call) CALL="$2"; shift ;;
    --passcode) PASS="$2"; shift ;;
    --filter) FILTER="$2"; shift ;;
    --domain) DOMAIN_IN="$2"; shift ;;
    --lan-host) LAN_HOST="$2"; shift ;;
    --tunnel-token) TUNNEL="$2"; shift ;;
    --site-call) SITE="$2"; SITE_SET=1; shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    --app-port) APP_PORT="$2"; shift ;;
    --no-tunnel) NO_TUNNEL=1 ;;
    --no-next-steps) NEXT_STEPS=0 ;;
    --fed-peers) FED_PEERS_IN="$2"; FED_PEERS_SET=1; shift ;;
    --fed-submit-instances) FED_SUBMIT_IN="$2"; shift ;;
    --fed-registry-key) FED_REGKEY_IN="$2"; shift ;;
    --net44-name) NET44_IN="$2"; NET44_SET=1; shift ;;
    --no-network) NETWORK=0 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || cp "$HERE/.env.example" "$ENV_FILE"

# ---- .env helpers ----------------------------------------------------------------------------------
# The active value of KEY (empty when absent or only present as a commented template line).
current() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }

# The shipped placeholder of KEY in .env.example (N0CALL, 00000, :80, …) — it counts as unset.
template() { grep -E "^$1=" "$HERE/.env.example" | tail -n 1 | cut -d= -f2- || true; }

# Write KEY=VALUE: replace the active line, else the commented template line (`# KEY=…`), else append.
write_line() {
  local key="$1" tmp
  tmp="$(mktemp)"
  if grep -qE "^$key=" "$ENV_FILE"; then
    K="$key" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k"=")==1 {print k"="v; next} {print}' \
      "$ENV_FILE" >"$tmp"
  elif grep -qE "^# ?$key=" "$ENV_FILE"; then
    K="$key" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; d=0}
      !d && ($0 ~ "^# ?"k"=") {print k"="v; d=1; next} {print}' "$ENV_FILE" >"$tmp"
  else
    cp "$ENV_FILE" "$tmp" && printf '%s=%s\n' "$key" "$2" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE" && rm -f "$tmp"
}

# Set KEY to VALUE unless .env already holds a different value the operator does not want replaced.
# A 3rd argument "secret" keeps the values out of the prompt. WROTE tells the caller whether it wrote.
setvar() {
  local key="$1" val="$2" cur shown
  WROTE=0
  [ -n "$val" ] || return 0
  cur="$(current "$key")"
  [ "$cur" = "$val" ] && return 0
  [ "$cur" = "$(template "$key")" ] && cur=""
  if [ -n "$cur" ] && [ "$ASSUME_YES" -ne 1 ]; then
    shown="'$cur' → '$val'"
    [ "${3:-}" = "secret" ] && shown="(value hidden)"
    if [ "$INTERACTIVE" -eq 1 ]; then
      read -rp "  $key is already set $shown. Replace it? [y/N] " yn
      case "$yn" in [yY]*) ;; *) echo "  kept $key"; return 0 ;; esac
    else
      echo "  kept $key (already set; pass --yes to replace it)"
      return 0
    fi
  fi
  write_line "$key" "$val"
  WROTE=1
}

# Generate a secret only while it is empty.
ensure_secret() {
  if [ -n "$(current "$1")" ]; then
    echo "  kept $1"
  else
    write_line "$1" "$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "  generated $1"
  fi
}

ask() { # ask VAR "prompt" default
  local reply
  if [ "$INTERACTIVE" -eq 1 ]; then
    read -rp "$2${3:+ [$3]}: " reply
    printf -v "$1" '%s' "${reply:-$3}"
  else
    printf -v "$1" '%s' "$3"
  fi
}

# ---- questions ---------------------------------------------------------------------------------------
echo "=== aprscaching setup wizard ==="
existing_admin="$(current ADMIN_CALLSIGNS)"
existing_is_call="$(current APRSIS_CALLSIGN)"
[ "$existing_is_call" = "N0CALL" ] && existing_is_call=""
ask CALL "Your callsign — you administer this instance (e.g. OE8APR)" "${CALL:-${existing_admin%%,*}}"
CALL="$(printf '%s' "${CALL:-$existing_is_call}" | tr '[:lower:]' '[:upper:]')"
if [ -z "$CALL" ]; then
  echo "A callsign is required (--call)." >&2
  exit 2
fi
existing_pass="$(current APRSIS_PASSCODE)"
[ "$existing_pass" = "00000" ] && existing_pass=""
ask PASS "APRS-IS passcode for $CALL (blank = receive-only, -1)" "${PASS:-$existing_pass}"
ask FILTER "APRS-IS filter (e.g. r/47.07/15.42/300 — 300 km around a point)" "${FILTER:-$(current APRSIS_FILTER)}"

# How people reach the instance decides DOMAIN (what Caddy serves) and APP_URL (the public origin).
existing_app="$(current APP_URL)"
existing_host="${existing_app#*://}"
existing_host="${existing_host%%/*}"
MODE=""
if [ -n "$TUNNEL" ]; then MODE=tunnel
elif [ -n "$DOMAIN_IN" ]; then MODE=domain
elif [ -n "$LAN_HOST" ]; then MODE=lan
fi
if [ "$NO_TUNNEL" -eq 1 ] && [ "$MODE" = tunnel ]; then
  echo "This installation offers no Cloudflare Tunnel (--no-tunnel); leave out --tunnel-token." >&2
  exit 2
fi
if [ -z "$MODE" ] && [ "$INTERACTIVE" -eq 1 ]; then
  echo "How do people reach this instance?"
  if [ "$NO_TUNNEL" -eq 1 ]; then
    echo "  1) a public domain, through your own reverse proxy with TLS"
    echo "  2) the local network only — off-grid, plain http"
    read -rp "Choose 1-2 [1]: " m
    case "${m:-1}" in 2) MODE=lan ;; *) MODE=domain ;; esac
  else
    echo "  1) a public domain; Caddy fetches the TLS certificate (ports 80+443 open)"
    echo "  2) a public domain through a Cloudflare Tunnel (no open ports; home connections, CGNAT)"
    echo "  3) the local network only — off-grid, plain http"
    read -rp "Choose 1-3 [1]: " m
    case "${m:-1}" in 2) MODE=tunnel ;; 3) MODE=lan ;; *) MODE=domain ;; esac
  fi
fi
MODE="${MODE:-lan}"
case "$MODE" in
  domain | tunnel)
    ask DOMAIN_IN "Public hostname (e.g. aprs.example.net)" "${DOMAIN_IN:-$existing_host}"
    [ -n "$DOMAIN_IN" ] || { echo "A hostname is required (--domain)." >&2; exit 2; }
    APP_URL="https://$DOMAIN_IN"
    if [ "$MODE" = tunnel ]; then
      ask TUNNEL "Cloudflare Tunnel token" "${TUNNEL:-$(current TUNNEL_TOKEN)}"
      [ -n "$TUNNEL" ] || { echo "A tunnel token is required (--tunnel-token)." >&2; exit 2; }
      CADDY_DOMAIN=":80" # TLS terminates at Cloudflare's edge
      HEALTH="$APP_URL/health"
    else
      CADDY_DOMAIN="$DOMAIN_IN"
      HEALTH="$APP_URL/health"
    fi
    ;;
  lan)
    guess="$(hostname -I 2>/dev/null | awk '{print $1}')"
    case "$existing_app" in http://*) guess="${existing_host%:*}" ;; esac
    ask LAN_HOST "Address other devices reach this box at" "${LAN_HOST:-${guess:-localhost}}"
    APP_URL="http://${LAN_HOST:-localhost}${APP_PORT:+:$APP_PORT}"
    CADDY_DOMAIN=":80"
    HEALTH="$APP_URL/health"
    ;;
esac

# ---- federation (public instances only) -------------------------------------------------------------------
# A peer listed in FED_PEERS starts trusted, and a 44Net peer must earn that: it is onboarded from Instance
# admin (admitted unvetted) instead. A name under ampr.org or an address in 44/8 is a 44Net peer.
is_44net_peer() {
  local host="${1#*://}"
  host="${host%%/*}"
  host="${host%%:*}"
  case "$host" in *.ampr.org | ampr.org | 44.*) return 0 ;; *) return 1 ;; esac
}
check_peers() {
  local p
  for p in ${1//,/ }; do
    case "$p" in https://*) ;; *) echo "Peer '$p' is not an https URL." >&2; return 1 ;; esac
    if is_44net_peer "$p"; then
      echo "Peer '$p' is on 44Net: onboard it from Instance admin, which admits it unvetted, not FED_PEERS." >&2
      return 1
    fi
  done
}
if [ "$MODE" != lan ]; then
  if [ "$FED_PEERS_SET" -eq 0 ]; then
    echo "Federation: instances you know and trust can mirror caches and corroborate finds with this one."
    ask FED_PEERS_IN "Their https URLs, comma-separated (blank = none for now)" "$(current FED_PEERS)"
  fi
  FED_PEERS_IN="$(printf '%s' "$FED_PEERS_IN" | tr -d ' ')"
  [ -z "$FED_PEERS_IN" ] || check_peers "$FED_PEERS_IN" || exit 2
  if [ -n "$(current FED_SUBMIT_SECRET)" ] && [ -z "$(current FED_SUBMIT_INSTANCES)" ]; then
    echo "This instance is a federation hub (FED_SUBMIT_SECRET); list the spokes allowed to submit to it."
    ask FED_SUBMIT_IN "Spoke instance ids, comma-separated" "$FED_SUBMIT_IN"
    [ -n "$FED_SUBMIT_IN" ] || { echo "A hub needs its spoke list (--fed-submit-instances)." >&2; exit 2; }
  fi
  if { [ -n "$(current FED_REGISTRY)" ] || [ -n "$(current FED_REGISTRY_DNS)" ]; } && [ -z "$(current FED_REGISTRY_KEY)" ]; then
    echo "A federation registry is configured; pin its authority's public key, or the gateway refuses to start."
    ask FED_REGKEY_IN "Registry authority key (base64url Ed25519)" "$FED_REGKEY_IN"
    [ -n "$FED_REGKEY_IN" ] || { echo "The registry needs its authority key (--fed-registry-key)." >&2; exit 2; }
  fi
  if [ "$NET44_SET" -eq 0 ]; then
    ask NET44_IN "This instance's 44Net name, if it has one (e.g. aprscaching.${CALL,,}.ampr.org; blank = none)" ""
  fi
fi

if [ "$SITE_SET" -eq 0 ]; then
  echo "An RF receiver you operate (a TNC on the ingest box) can attest what it hears directly: Tier A."
  ask SITE "Its callsign-SSID (e.g. ${CALL}-10; blank = none yet)" "$(current RF_SITE_CALL)"
fi
SITE="$(printf '%s' "$SITE" | tr '[:lower:]' '[:upper:]')"

# ---- write .env ----------------------------------------------------------------------------------------
echo "Writing $ENV_FILE"
setvar ADMIN_CALLSIGNS "$CALL"
setvar APRSIS_CALLSIGN "$CALL"
setvar APRSIS_PASSCODE "${PASS:--1}" secret
setvar APRSIS_FILTER "$FILTER"
setvar APP_URL "$APP_URL"
# DOMAIN (what Caddy serves) follows the public URL: it changes exactly when APP_URL does
[ "$WROTE" -eq 1 ] && write_line DOMAIN "$CADDY_DOMAIN"
[ "$MODE" = tunnel ] && setvar TUNNEL_TOKEN "$TUNNEL" secret
if [ -n "$SITE" ]; then
  # one receiving site, named on both sides: the ingest box stamps it, the gateway attests it
  setvar RF_SITE_CALL "$SITE"
  setvar FIRST_PARTY_SITES "$SITE"
fi
# The safe federation posture, written out so the operator sees it. A value the operator chose is kept,
# and an unsafe one is pointed out rather than replaced.
default_var() { [ -n "$(current "$1")" ] || { write_line "$1" "$2"; echo "  set $1=$2"; }; }
default_var D1_DAILY_WRITE_BUDGET 0
if [ "$MODE" = lan ]; then
  [ -z "$(current FED_PEERS)$(current FED_HUB_URL)" ] ||
    echo "  NOTE: federation is configured (FED_PEERS / FED_HUB_URL) on a LAN instance; kept as it is."
else
  default_var FED_AUTO_PROMOTE 0
  default_var FED_CORROBORATION_QUORUM 2
  default_var FED_DISCOVER 0
  [ -z "$FED_PEERS_IN" ] || setvar FED_PEERS "$FED_PEERS_IN"
  [ -z "$FED_SUBMIT_IN" ] || setvar FED_SUBMIT_INSTANCES "$FED_SUBMIT_IN"
  [ -z "$FED_REGKEY_IN" ] || setvar FED_REGISTRY_KEY "$FED_REGKEY_IN"
  if [ -n "$NET44_IN" ]; then
    # single-quoted, as compose and systemd both read a quoted JSON value intact
    setvar FED_ENDPOINTS "'[{\"transport\":\"https\",\"address\":\"$APP_URL\",\"priority\":10},{\"transport\":\"44net\",\"address\":\"$NET44_IN\",\"priority\":20}]'"
    echo "  44Net: check the name with the self-check in Instance admin -> Setup (docs/operate/44net.md)."
  fi
  case "$(current FED_DISCOVER)" in 1 | true | yes)
    echo "  WARN: FED_DISCOVER is on, so learned peers are added (disabled). Set it to 0 to turn discovery off." ;;
  esac
  case "$(current FED_AUTO_PROMOTE)" in 0 | "") ;; *) echo "  WARN: FED_AUTO_PROMOTE is not 0: peers can become trusted without you." ;; esac
  case "$(current FED_CORROBORATION_QUORUM)" in 0 | 1) echo "  WARN: FED_CORROBORATION_QUORUM below 2 lets one peer lift a find to Tier A." ;; esac
  if [ -n "$(current FED_PEERS)" ] && ! check_peers "$(current FED_PEERS)" 2>/dev/null; then
    echo "  WARN: FED_PEERS holds a 44Net or non-https peer, which starts trusted. Onboard 44Net peers from Instance admin."
  fi
fi
ensure_secret INGEST_SECRET
ensure_secret OPERATOR_SECRET
if [ -n "$(current FED_PRIVATE_KEY)" ]; then
  echo "  kept FED_PRIVATE_KEY"
elif FEDKEY="$(node "$ROOT/tools/fedkey/genkey.mjs" --raw 2>/dev/null)" && [ -n "$FEDKEY" ]; then
  write_line FED_PRIVATE_KEY "$FEDKEY"
  echo "  generated FED_PRIVATE_KEY"
else
  FEDKEY_TODO=1
  echo "  FED_PRIVATE_KEY not generated (no Node.js ≥ 22 on this host) — see the steps below"
fi
# SESSION_SECRET stays empty: the gateway generates it on first start and keeps it in the data volume.

if [ "$NETWORK" -eq 1 ]; then
  echo "Checking APRS-IS reachability..."
  (exec 3<>/dev/tcp/rotate.aprs2.net/14580 && echo "  APRS-IS reachable." && exec 3>&-) 2>/dev/null ||
    echo "  WARN: could not reach APRS-IS (fine off-grid; the RF ingest still works)."
fi

# ---- next steps ------------------------------------------------------------------------------------------
[ "$NEXT_STEPS" -eq 1 ] || exit 0
UP="SOURCE_COMMIT=\$(git rev-parse HEAD) docker compose up -d --build"
[ "$MODE" = tunnel ] && UP="SOURCE_COMMIT=\$(git rev-parse HEAD) docker compose -f docker-compose.yml -f compose.home.yml up -d --build"
cat <<EOF

Next, from $HERE:
EOF
if [ "${FEDKEY_TODO:-0}" -eq 1 ]; then
  cat <<EOF
  0. Generate the federation signing key inside the image and paste it into FED_PRIVATE_KEY in .env:
       docker compose build gateway && docker compose run --rm --no-deps gateway node tools/fedkey/genkey.mjs --raw
EOF
fi
cat <<EOF
  1. Start:   $UP
  2. Health:  curl -fsS $HEALTH
  3. Sign in: open $APP_URL and create the account for $CALL.
EOF
if [ "$MODE" = lan ]; then
  cat <<EOF
     Plain http has no passkeys and this box sends no email, so sign in with a one-time link:
       docker compose exec gateway node tools/admin/signin-link.mjs $CALL
EOF
fi
cat <<EOF
  4. Verify:  docker compose exec gateway node tools/admin/verify-call.mjs $CALL
     This confirms your call with OPERATOR_SECRET and opens Instance admin (the Admin rail entry).
  5. Finish:  Instance admin -> Setup ($APP_URL) lists what is left to configure, in order.
Keep OPERATOR_SECRET off any separate ingest box; that box needs only INGEST_SECRET.
EOF
