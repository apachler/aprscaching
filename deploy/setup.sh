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
# Options: --env-file PATH (default ./.env) · --no-network (skip the APRS-IS reachability check) ·
#          --yes (replace existing values without asking) · --help
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ENV_FILE="$HERE/.env"
INTERACTIVE=1
NETWORK=1
ASSUME_YES=0
CALL="" PASS="" FILTER="" DOMAIN_IN="" LAN_HOST="" TUNNEL="" SITE="" SITE_SET=0

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
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
if [ -z "$MODE" ] && [ "$INTERACTIVE" -eq 1 ]; then
  echo "How do people reach this instance?"
  echo "  1) a public domain; Caddy fetches the TLS certificate (ports 80+443 open)"
  echo "  2) a public domain through a Cloudflare Tunnel (no open ports; home connections, CGNAT)"
  echo "  3) the local network only — off-grid, plain http"
  read -rp "Choose 1-3 [1]: " m
  case "${m:-1}" in 2) MODE=tunnel ;; 3) MODE=lan ;; *) MODE=domain ;; esac
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
    case "$existing_app" in http://*) guess="$existing_host" ;; esac
    ask LAN_HOST "Address other devices reach this box at" "${LAN_HOST:-${guess:-localhost}}"
    APP_URL="http://${LAN_HOST:-localhost}"
    CADDY_DOMAIN=":80"
    HEALTH="$APP_URL/health"
    ;;
esac

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
UP="docker compose up -d --build"
[ "$MODE" = tunnel ] && UP="docker compose -f docker-compose.yml -f compose.home.yml up -d --build"
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
Keep OPERATOR_SECRET off any separate ingest box; that box needs only INGEST_SECRET.
EOF
