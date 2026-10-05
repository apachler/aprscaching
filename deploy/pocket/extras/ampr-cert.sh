#!/usr/bin/env bash
# A Let's Encrypt certificate for the station's ampr.org name (by default aprscaching-pocket.<call>.ampr.org),
# obtained by hand with a DNS-01 challenge: browsers grant passkeys, location and Web Bluetooth only to https
# origins, and members who reach the station by that name over 44Net get them with a certificate the browser trusts.
#
#   bash ~/aprscaching/deploy/pocket/extras/ampr-cert.sh --host aprscaching-pocket.oe8apr.ampr.org
#   bash ~/aprscaching/deploy/pocket/extras/ampr-cert.sh --host aprscaching-pocket.oe8apr.ampr.org --use
#
# lego (pkg install lego) asks Let's Encrypt for the certificate. This script prints the TXT record to add
# at _acme-challenge.<name> in the ARDC portal, looks it up every minute until it is published (the portal
# publishes about once an hour), then lets lego finish, and copies the certificate to ~/.aprscaching/tls.
# Nothing in the portal is automated, so every renewal repeats the record: status.sh warns 14 days before
# the certificate expires; run this again then (it renews only when the certificate is due, --force
# renews anyway). Running it means accepting the Let's Encrypt Subscriber Agreement.
#
# The certificate names only the ampr.org name. --use serves it on the gateway's https port instead of
# the station certificate from tls.sh: hotspot visitors who open the station by address then see a name
# warning. tls.sh turns the station certificate back on. Over amateur RF (a HAMNET radio link), plain http
# stays the way in: RF carries no encryption.
#
# Options:
#   --host NAME          the station's ampr.org name, e.g. aprscaching-pocket.<call>.ampr.org
#   --email ADDR         contact address for the ACME account (optional)
#   --use                serve the certificate on the https port (HTTPS_PORT, default 8443)
#   --force              renew even when the certificate is not due
#   --staging            Let's Encrypt's staging CA: test certificates browsers do not trust
#   --wait-min N         minutes to wait for the record to be published (default 180)
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

HOST=""
EMAIL=""
USE=0
FORCE=0
STAGING=0
WAIT_MIN=180
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift ;;
    --email) EMAIL="${2:-}"; shift ;;
    --use) USE=1 ;;
    --force) FORCE=1 ;;
    --staging) STAGING=1 ;;
    --wait-min) WAIT_MIN="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths

HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
HOST="${HOST%.}"
valid_ampr_host "$HOST" || die "--host takes the station's ampr.org name, e.g. --host aprscaching-pocket.oe8apr.ampr.org (got '${HOST}')."
case "$WAIT_MIN" in '' | *[!0-9]*) die "--wait-min takes a number of minutes (got '$WAIT_MIN')." ;; esac
have lego || die "lego is missing." "Install it with:  pkg install lego"

ACME="$TLS_DIR/acme"
CERT="$TLS_DIR/ampr.crt"
KEY="$TLS_DIR/ampr.key"
mkdir -p "$ACME" "$RUN_DIR"
chmod 700 "$TLS_DIR" "$ACME"
POLL_S="${APRSCACHING_ACME_POLL_S:-60}"

# Whether the public DNS already answers the challenge record with VALUE (through DOH_URL, else Cloudflare's
# DNS-over-HTTPS). The DNS-over-HTTPS JSON answer carries each TXT string in quotes.
published() {
  local doh answer
  doh="$(env_get DOH_URL)"
  doh="${doh:-https://cloudflare-dns.com/dns-query}"
  answer="$(curl -fsS --max-time 10 -H 'accept: application/dns-json' "$doh?name=$1&type=TXT" 2>/dev/null)" || return 1
  printf '%s' "$answer" | grep -qF "$2"
}

# ---- lego, with its prompt answered once the record is published ----------------------------------
args=(run --accept-tos --domains "$HOST" --dns manual --path "$ACME" --log.format text --no-random-sleep)
[ -z "$EMAIL" ] || args+=(--email "$EMAIL")
[ "$STAGING" -eq 0 ] || args+=(--server letsencrypt-staging)
[ "$FORCE" -eq 0 ] || args+=(--renew-force)

step "Certificate for $HOST$([ "$STAGING" -eq 1 ] && printf ' (staging)')"
LOG="$RUN_DIR/ampr-cert.log"
FIFO="$RUN_DIR/ampr-cert.in"
rm -f "$FIFO"
mkfifo -m 600 "$FIFO"
exec 3<>"$FIFO"
# After the Enter, lego checks the record on ampr.org's own name servers; 10 minutes covers their sync.
MANUAL_PROPAGATION_TIMEOUT=600 lego "${args[@]}" <&3 >"$LOG" 2>&1 &
LEGO=$!
trap 'kill "$LEGO" 2>/dev/null || true; rm -f "$FIFO"' EXIT

shown=0
while :; do
  lines="$(wc -l <"$LOG")"
  while [ "$shown" -lt "$lines" ]; do
    shown=$((shown + 1))
    line="$(sed -n "${shown}p" "$LOG")"
    info "lego: $line"
    case "$line" in
      *" IN TXT "*)
        name="$(printf '%s' "$line" | sed -E 's/.*(_acme-challenge\.[^ ]*[^. ])\.? +[0-9]+ +IN +TXT +"([^"]*)".*/\1/')"
        value="$(printf '%s' "$line" | sed -E 's/.*(_acme-challenge\.[^ ]*[^. ])\.? +[0-9]+ +IN +TXT +"([^"]*)".*/\2/')"
        step "Add this TXT record in the ARDC portal (portal.ampr.org, your DNS records)"
        info "name:   $name"
        info "type:   TXT"
        info "value:  $value"
        info "Replace any earlier _acme-challenge record. The portal publishes about once an hour; this"
        info "script looks it up every $((POLL_S / 60 > 0 ? POLL_S / 60 : 1)) min for up to $WAIT_MIN min (Ctrl-C stops; run it again to resume)."
        deadline=$(($(date +%s) + WAIT_MIN * 60))
        until published "$name" "$value"; do
          if [ "$(date +%s)" -ge "$deadline" ]; then
            die "the record did not appear in DNS within $WAIT_MIN min." \
              "Check it in the portal, then run this again: Let's Encrypt asks for a new value then."
          fi
          sleep "$POLL_S"
        done
        info "published; Let's Encrypt checks it now"
        printf '\n' >&3
        ;;
    esac
  done
  kill -0 "$LEGO" 2>/dev/null || break
  sleep 1
done
status=0
wait "$LEGO" || status=$?
[ "$status" -eq 0 ] || die "lego failed (status $status); its output is above and in $LOG."

# ---- the files the gateway reads -------------------------------------------------------------------
crt="$(find "$ACME" -type f -name "$HOST.crt" | head -n 1)"
key="$(find "$ACME" -type f -name "$HOST.key" | head -n 1)"
[ -n "$crt" ] && [ -n "$key" ] || die "lego finished, but no certificate for $HOST is in $ACME."
if ! cmp -s "$crt" "$CERT" || ! cmp -s "$key" "$KEY"; then
  # The key first, then the certificate: a reload between the two never pairs a new certificate with
  # the old key.
  install -m 600 "$key" "$KEY.new" && mv -f "$KEY.new" "$KEY"
  install -m 644 "$crt" "$CERT.new" && mv -f "$CERT.new" "$CERT"
  printf '%s\n' "$HOST" >"$TLS_DIR/ampr.host"
  info "certificate in $CERT, valid until $(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)"
  changed=1
else
  info "not due for renewal: valid until $(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)"
  changed=0
fi

if [ "$USE" -eq 1 ] && [ "$(env_get TLS_CERT)" != "$CERT" ]; then
  port="$(env_get HTTPS_PORT)"
  port="${port:-8443}"
  env_set HTTPS_PORT "$port"
  env_set TLS_CERT "$CERT"
  env_set TLS_KEY "$KEY"
  # The station CA serves only tls.sh's certificate.
  env_unset TLS_CA_CERT
  info "the gateway serves https://$HOST:$port with it (tls.sh turns the station certificate back on)"
  if session_exists && restart_proc gateway; then info "the gateway restarts"; fi
elif [ "$changed" -eq 1 ] && [ "$(env_get TLS_CERT)" = "$CERT" ]; then
  pid="$(state_get gateway pid)"
  if is_ours "$pid" "$(proc_entry gateway)"; then
    kill -HUP "$pid"
    info "the gateway reloads the certificate"
  fi
elif [ "$(env_get TLS_CERT)" != "$CERT" ]; then
  info "serve it with --use"
fi
