#!/usr/bin/env bash
# https for visitors on the phone's hotspot. A browser grants location, and a signed-in session, only to
# a secure origin; on the phone itself http://localhost is one, but a visitor opening
# http://<hotspot address>:8787 gets neither. This script gives the gateway an https listener with a
# certificate from a CA of the station's own:
#
#   - the CA is made once in ~/.aprscaching/tls (P-256, name-constrained to private and loopback
#     addresses, so even a visitor who installs it trusts it for nothing on the internet);
#   - the station certificate names 127.0.0.1, localhost and every private address the phone has (the
#     hotspot, a joined Wi-Fi, tethering; not mobile data), is valid 30 days, and is issued again when a
#     new address appears, or when it has less than 7 days left;
#   - the .env gets HTTPS_PORT, TLS_CERT, TLS_KEY, TLS_CA_CERT (served at /pocket-ca.crt) and
#     OPERATOR_LINKS_FOR_ANY_CALL=1, so signin-link.sh --hotspot can sign a visitor in under their own call.
#
# APP_URL stays http://localhost:<PORT>: the owner keeps using the station on the phone as before. With
# https on, a page load from another device on the plain port is redirected to https. A visitor either
# accepts the certificate warning or installs the CA from http://<hotspot address>:<PORT>/pocket-ca.crt.
#
#   bash ~/aprscaching/deploy/pocket/tls.sh              # turn https on (or re-apply), restarts the gateway
#   bash ~/aprscaching/deploy/pocket/tls.sh --renew      # issue the certificate again if needed
#   bash ~/aprscaching/deploy/pocket/tls.sh --disable    # turn https off; the CA stays for next time
#
# start.sh renews before the gateway starts and runs --watch in the tmux window `tls`, which checks every
# 30 s and hands a new certificate to the running gateway (SIGHUP, no restart) when the hotspot comes up
# with a new address.
#
# Options:
#   --port N             the https port                 (default 8443, or the one already set)
#   --renew              issue the station certificate again when it lacks a current address or expires
#                        within 7 days, then reload it in the gateway
#   --force              with --renew: issue it again in any case
#   --watch              --renew every 30 s (APRSCACHING_TLS_WATCH_S) until https is turned off
#   --disable            remove the https settings from the .env and restart the gateway
#   --quiet              only report changes and problems
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

MODE=enable
FORCE=0
QUIET=0
HTTPS_PORT_OPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) HTTPS_PORT_OPT="${2:-}"; shift ;;
    --renew) MODE=renew ;;
    --force) FORCE=1 ;;
    --watch) MODE=watch ;;
    --disable) MODE=disable ;;
    --quiet) QUIET=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
TLS_CA_KEY="$TLS_DIR/ca.key"
TLS_IPS="$TLS_DIR/station.ips"
RENEW_BEFORE=$((7 * 86400))
LEAF_DAYS=30
CA_DAYS=3650

say() { [ "$QUIET" -eq 1 ] || info "$@"; }
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."
have openssl || die "openssl is missing." "Install it with:  pkg install openssl-tool"

# ---- certificates --------------------------------------------------------------------------------------
# The station's call names the CA, with a random tag so two stations of one operator stay apart.
station_call() {
  local call
  call="$(env_get ADMIN_CALLSIGNS)"
  call="${call%%,*}"
  printf '%s' "${call:-station}" | tr -cd 'A-Za-z0-9-'
}

make_ca() {
  local cnf="$TLS_DIR/ca.cnf.$$"
  cat >"$cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:127.0.0.0/255.0.0.0,permitted;DNS:localhost
EOF
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -sha256 \
    -days "$CA_DAYS" -config "$cnf" -extensions v3_ca \
    -subj "/CN=aprscaching Pocket CA $(station_call) $(openssl rand -hex 4)" \
    -keyout "$TLS_CA_KEY" -out "$TLS_CA" 2>/dev/null ||
    { rm -f "$cnf"; die "openssl could not create the CA in $TLS_DIR."; }
  rm -f "$cnf"
  chmod 600 "$TLS_CA_KEY"
  chmod 644 "$TLS_CA"
  say "created the station CA ($TLS_CA)"
}

# The addresses the certificate should name, one per line, sorted.
wanted_ips() { { echo 127.0.0.1; local_ipv4 | awk '{print $2}'; } | sort -u; }

# A certificate that still names every current address stays: an address that went away (the hotspot
# turned off) is left in it, so turning the hotspot back on at the same address changes nothing. The
# 7-day renewal drops the addresses no longer in use.
needs_renew() {
  local ip
  [ "$FORCE" -eq 0 ] || return 0
  [ -f "$TLS_LEAF" ] && [ -f "$TLS_LEAF_KEY" ] && [ -f "$TLS_IPS" ] || return 0
  openssl x509 -checkend "$RENEW_BEFORE" -noout -in "$TLS_LEAF" >/dev/null 2>&1 || return 0
  while read -r ip; do
    [ -z "$ip" ] || grep -qxF "$ip" "$TLS_IPS" || return 0
  done <<<"$1"
  return 1
}

# Issue the station certificate for the addresses in $1 (newline-separated). The new key and certificate
# replace the old pair only once both exist, and the certificate last, so a reload never pairs a new
# certificate with an old key for longer than the two renames.
issue_leaf() {
  local ips=$1 san="DNS:localhost" ip tmp="$TLS_DIR/new.$$"
  while read -r ip; do [ -z "$ip" ] || san="$san,IP:$ip"; done <<<"$ips"
  mkdir -p "$tmp"
  cat >"$tmp/ext" <<EOF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $san
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
  if ! openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -sha256 \
    -subj "/CN=aprscaching Pocket $(station_call)" -keyout "$tmp/key" -out "$tmp/csr" 2>/dev/null ||
    ! openssl x509 -req -sha256 -days "$LEAF_DAYS" -in "$tmp/csr" -CA "$TLS_CA" -CAkey "$TLS_CA_KEY" \
      -set_serial "0x$(openssl rand -hex 16)" -extfile "$tmp/ext" -out "$tmp/crt" 2>/dev/null; then
    rm -rf "$tmp"
    return 1
  fi
  chmod 600 "$tmp/key"
  mv -f "$tmp/key" "$TLS_LEAF_KEY"
  mv -f "$tmp/crt" "$TLS_LEAF"
  printf '%s\n' "$ips" >"$TLS_IPS"
  rm -rf "$tmp"
}

# Hand the files to the running gateway: SIGHUP to the node process itself makes it reload them for new
# connections (a file that fails to load keeps the previous certificate).
reload_gateway() {
  local pid
  pid="$(state_get gateway pid)"
  if is_ours "$pid" "$(proc_entry gateway)"; then
    kill -HUP "$pid"
    info "the gateway reloads the certificate"
  fi
}

ensure_ca() {
  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR"
  if [ ! -f "$TLS_CA" ] || [ ! -f "$TLS_CA_KEY" ]; then make_ca; fi
}

# Renew when needed (ISSUED=1 when it did); succeeds with nothing to do, fails only when openssl fails.
ISSUED=0
renew() {
  local ips
  ISSUED=0
  ips="$(wanted_ips)"
  needs_renew "$ips" || { say "certificate up to date for: $(paste -sd ' ' <<<"$ips")"; return 0; }
  if issue_leaf "$ips"; then
    ISSUED=1
    info "certificate issued for: $(paste -sd ' ' <<<"$ips") (valid $LEAF_DAYS days)"
    return 0
  fi
  warn "openssl could not issue the certificate; the previous one stays."
  return 1
}

case "$MODE" in
  enable)
    port="${HTTPS_PORT_OPT:-$(env_get HTTPS_PORT)}"
    port="${port:-8443}"
    case "$port" in '' | *[!0-9]*) die "--port needs a port number, not '$port'." ;; esac
    [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || die "--port must be 1024–65535 (lower ports need root)."
    [ "$port" != "$(gateway_port)" ] || die "--port $port is the plain port (PORT); pick another."
    step "https for visitors (port $port)"
    ensure_ca
    FORCE=1
    renew || die "no certificate, so https stays as it was."
    env_set HTTPS_PORT "$port"
    env_set TLS_CERT "$TLS_LEAF"
    env_set TLS_KEY "$TLS_LEAF_KEY"
    env_set TLS_CA_CERT "$TLS_CA"
    env_set OPERATOR_LINKS_FOR_ANY_CALL 1
    info "wrote HTTPS_PORT, TLS_CERT, TLS_KEY, TLS_CA_CERT and OPERATOR_LINKS_FOR_ANY_CALL=1 to $ENV_FILE"
    info "OPERATOR_LINKS_FOR_ANY_CALL=1 lets signin-link.sh sign in any call: keep OPERATOR_SECRET to"
    info "yourself, and turn https off (--disable) before sharing this station with another operator."
    if session_exists && restart_proc gateway; then
      APRSCACHING_DIR="$DIR" APRSCACHING_DATA="$DATA" bash "$HERE/start.sh" --no-attach >/dev/null
      info "the gateway runs https; the tmux window tls keeps the certificate current"
    else
      info "start the station (start.sh) to serve https"
    fi
    info "visitors: bash $HERE/signin-link.sh --hotspot <THEIR CALL>   (status.sh lists the https URLs)"
    ;;
  renew)
    [ -n "$(tls_port)" ] || die "https is off." "Turn it on with:  bash $HERE/tls.sh"
    ensure_ca
    renew || exit 1
    [ "$ISSUED" -eq 0 ] || reload_gateway
    ;;
  watch)
    QUIET=1
    info "keeping the https certificate current (checks every 30 s; this window ends when https is off)"
    while [ -n "$(tls_port)" ]; do
      ensure_ca
      if needs_renew "$(wanted_ips)"; then
        printf '%(%Y-%m-%d %H:%M:%S)T\n' -1
        if renew && [ "$ISSUED" -eq 1 ]; then reload_gateway; fi
      fi
      sleep "${APRSCACHING_TLS_WATCH_S:-30}"
    done
    info "https is off; the tls window closes"
    ;;
  disable)
    step "Turning https off"
    env_unset HTTPS_PORT TLS_CERT TLS_KEY TLS_CA_CERT OPERATOR_LINKS_FOR_ANY_CALL
    info "removed the https settings from $ENV_FILE (the CA in $TLS_DIR stays for next time)"
    if session_exists && restart_proc gateway; then info "the gateway serves plain http only"; fi
    ;;
esac
