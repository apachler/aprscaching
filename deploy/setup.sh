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
# starts with federation off.
#
# Options: --env-file PATH (default ./.env) · --no-network (skip the APRS-IS reachability check) ·
#          --yes (replace existing values without asking) · --app-port PORT (the LAN URL's port, when the
#          gateway answers on its own port rather than through Caddy) · --no-tunnel (offer no Cloudflare
#          Tunnel: the installer has no compose stack to run one) · --no-next-steps (the caller prints its
#          own) · --extra-origins ORIGIN,… (further addresses of this instance: https://<name> for a name Caddy
#          fetches a certificate for, such as the 44Net name; http://<name or address> for a HAMNET host
#          or a LAN, served as plain http; "-" clears them) · --help
# Federation (public instances): --fed-peers URL[#FINGERPRINT],… (peers you know: https://<name>, or
#          http://<name or address>[:port] for a HAMNET or LAN peer; trusted once a pinned fingerprint matches,
#          unvetted otherwise) ·
#          --fed-submit-instances ID,… (required on a hub, FED_SUBMIT_SECRET set) ·
#          --fed-registry-key KEY (required with FED_REGISTRY/FED_REGISTRY_DNS) ·
#          --net44-name NAME (this instance's 44Net name, e.g. aprscaching.oe8apr.ampr.org)
# Mail (sign-in links, the watch digest): --mail smtp|resend|none (left out non-interactively: kept as it is) ·
#          --email-from ADDRESS · --smtp-host HOST · --smtp-port PORT (587) · --smtp-secure starttls|tls|none ·
#          --smtp-user USER · --smtp-pass PASSWORD · --resend-key KEY. The SMTP password and the Resend key may
#          come from the SMTP_PASS and EMAIL_API_KEY environment variables instead, off the command line.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ENV_FILE="$HERE/.env"
INTERACTIVE=1
NETWORK=1
ASSUME_YES=0
CALL="" PASS="" FILTER="" DOMAIN_IN="" LAN_HOST="" TUNNEL="" SITE="" SITE_SET=0 APP_PORT="" NO_TUNNEL=0 NEXT_STEPS=1
FED_PEERS_IN="" FED_PEERS_SET=0 FED_SUBMIT_IN="" FED_REGKEY_IN="" NET44_IN="" NET44_SET=0 EXTRA_IN="" EXTRA_SET=0
MAIL="" MAIL_FROM="" SMTP_HOST_IN="" SMTP_PORT_IN="" SMTP_SECURE_IN="" SMTP_USER_IN=""
SMTP_PASS_IN="${SMTP_PASS:-}" RESEND_KEY_IN="${EMAIL_API_KEY:-}"

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
    --extra-origins) EXTRA_IN="$2"; EXTRA_SET=1; shift ;;
    --mail) MAIL="$2"; shift ;;
    --email-from) MAIL_FROM="$2"; shift ;;
    --smtp-host) SMTP_HOST_IN="$2"; shift ;;
    --smtp-port) SMTP_PORT_IN="$2"; shift ;;
    --smtp-secure) SMTP_SECURE_IN="$2"; shift ;;
    --smtp-user) SMTP_USER_IN="$2"; shift ;;
    --smtp-pass) SMTP_PASS_IN="$2"; shift ;;
    --resend-key) RESEND_KEY_IN="$2"; shift ;;
    --no-network) NETWORK=0 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# The .env holds the instance's secrets: created owner-only, and narrowed to owner-only when it is wider.
[ -f "$ENV_FILE" ] || (umask 077 && cp "$HERE/.env.example" "$ENV_FILE")
chmod 600 "$ENV_FILE"

# ---- .env helpers ----------------------------------------------------------------------------------
# The active value of KEY (empty when absent or only present as a commented template line).
current() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }

# The value of KEY with the quotes a shell-sourced .env needs taken off.
unquoted() {
  local v
  v="$(current "$1")"
  case "$v" in \"*\" | \'*\') v="${v:1:${#v}-2}" ;; esac
  printf '%s' "$v"
}

# VALUE as .env holds it: bare when it is plain, else in single quotes, which Compose, systemd and a shell that
# sources the file all read literally (a value holding a single quote is refused before it gets here).
quoted() {
  case "$1" in
    *[!A-Za-z0-9._~+/=@:,-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

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

# ask_secret VAR "prompt": read without echo; a blank answer keeps what VAR already holds.
ask_secret() {
  local reply
  [ "$INTERACTIVE" -eq 1 ] || return 0
  read -rsp "$2: " reply
  echo
  [ -z "$reply" ] || printf -v "$1" '%s' "$reply"
}

# Turn KEY off: its active line becomes a commented one, so the value stays visible but is not read.
unset_var() {
  local tmp
  grep -qE "^$1=" "$ENV_FILE" || return 0
  tmp="$(mktemp)"
  K="$1" awk 'BEGIN{k=ENVIRON["K"]} index($0, k"=")==1 {print "# "$0; next} {print}' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE" && rm -f "$tmp"
  echo "  turned off $1"
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

# ---- further addresses (EXTRA_ORIGINS) ------------------------------------------------------------------------
# norm_origins LIST: LIST as bare origins, lowercased, comma-joined, without APP_URL's own; non-zero with the
# offending entry on stderr when one is not https:// or http:// followed by a host and an optional port.
norm_origins() {
  local o out="" app
  app="$(printf '%s' "$APP_URL" | tr '[:upper:]' '[:lower:]')"
  for o in ${1//,/ }; do
    o="$(printf '%s' "${o%/}" | tr '[:upper:]' '[:lower:]')"
    if ! printf '%s' "$o" | grep -Eq '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'; then
      echo "'$o' is not an origin: https://<name> or http://<name or address>, an optional port, no path." >&2
      return 1
    fi
    [ "$o" != "$app" ] || continue
    case ",$out," in *",$o,"*) continue ;; esac
    out="${out:+$out,}$o"
  done
  printf '%s' "$out"
}
if [ "$EXTRA_SET" -eq 0 ] && [ "$INTERACTIVE" -eq 1 ]; then
  echo "Further addresses of this instance, beside $APP_URL: https://<name> for a name with a certificate (the"
  echo "44Net name), http://<name or address> for a HAMNET host or a LAN, served as plain http."
  ask EXTRA_IN "Comma-separated (blank = none, - = remove them)" "$(unquoted EXTRA_ORIGINS)"
  EXTRA_SET=1
fi
if [ "$EXTRA_SET" -eq 1 ] && [ "$EXTRA_IN" != - ]; then
  EXTRA_IN="$(norm_origins "$EXTRA_IN")" || exit 2
fi
if [ "$MODE" = tunnel ] && printf '%s' "$EXTRA_IN" | grep -q 'https://'; then
  echo "  NOTE: in Tunnel mode Caddy publishes no ports; an https address needs ports 80 and 443 reachable on it."
fi

# ---- federation (public instances only) -------------------------------------------------------------------
# A peer listed in FED_PEERS with its key fingerprint starts trusted once its key matches. An https peer on 44Net
# (a name under ampr.org, or an address in 44Net: 44.0.0.0/9 or 44.128.0.0/10) is onboarded from Instance admin
# by callsign instead, where DNS attests its name. A plain http:// entry is a HAMNET or LAN peer: the gateway dials
# it like a hamnet endpoint. Its scheme decides, since no address range tells a HAMNET host from one on the internet.
is_44net_peer() {
  local host="${1#*://}" b
  host="${host%%[/:#]*}"
  case "$host" in *.ampr.org | ampr.org) return 0 ;; 44.*) ;; *) return 1 ;; esac
  IFS=. read -r _ b _ _ <<<"$host"
  case "$b" in '' | *[!0-9]*) return 1 ;; esac
  [ "$b" -lt 192 ] # 44.192.0.0/10 was sold in 2019 and is not 44Net
}
check_peers() {
  local p
  for p in ${1//,/ }; do
    case "$p" in
      https://*)
        if is_44net_peer "$p"; then
          echo "Peer '$p' is on 44Net: onboard it from Instance admin, which admits it unvetted, not FED_PEERS." >&2
          return 1
        fi
        ;;
      http://*)
        if ! printf '%s' "${p%%#*}" | grep -Eq '^http://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$'; then
          echo "Peer '$p' is not a HAMNET or LAN peer: http://<name or address>, an optional port, no path." >&2
          return 1
        fi
        ;;
      *) echo "Peer '$p' is neither an https URL nor an http:// HAMNET or LAN peer." >&2; return 1 ;;
    esac
  done
}
if [ "$MODE" != lan ]; then
  if [ "$FED_PEERS_SET" -eq 0 ]; then
    echo "Federation: instances you know and trust can mirror caches and corroborate finds with this one."
    echo "Give each as https://<name>, or http://<name or address>[:port] for a HAMNET or LAN peer."
    ask FED_PEERS_IN "Their URLs, comma-separated (blank = none for now)" "$(current FED_PEERS)"
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
    ask NET44_IN "This instance's 44Net name, if it has one (e.g. aprscaching.$(printf '%s' "$CALL" | tr '[:upper:]' '[:lower:]').ampr.org; blank = none)" ""
  fi
  NET44_IN="$(printf '%s' "$NET44_IN" | tr '[:upper:]' '[:lower:]')"
  case "$NET44_IN" in
    '' | *.*.ampr.org) ;;
    *)
      echo "--net44-name takes a name under your call, e.g. aprscaching.<call>.ampr.org; the base name <call>.ampr.org stays free for your other uses." >&2
      exit 2
      ;;
  esac
fi

if [ "$SITE_SET" -eq 0 ]; then
  echo "An RF receiver you operate (a TNC on the ingest box) can attest what it hears directly: Tier A."
  ask SITE "Its callsign-SSID (e.g. ${CALL}-10; blank = none yet)" "$(current RF_SITE_CALL)"
fi
SITE="$(printf '%s' "$SITE" | tr '[:lower:]' '[:upper:]')"

# Mail follows the gateway's rule: SMTP when SMTP_HOST is set, else Resend when EMAIL_API_KEY is set, else none.
if [ -n "$(current SMTP_HOST)" ]; then mail_now=smtp
elif [ -n "$(current EMAIL_API_KEY)" ]; then mail_now=resend
else mail_now=none; fi
if [ -z "$MAIL" ] && [ "$INTERACTIVE" -eq 1 ]; then
  echo "How should the instance send mail (sign-in links, address confirmations, the watch digest)?"
  echo "  1) an SMTP server: your own mail server or a hosted mailbox"
  echo "  2) the Resend API"
  echo "  3) no mail: members sign in with passkeys, or with a one-time link you mint"
  case "$mail_now" in smtp) d=1 ;; resend) d=2 ;; *) d=3 ;; esac
  read -rp "Choose 1-3 [$d]: " m
  case "${m:-$d}" in 1) MAIL=smtp ;; 2) MAIL=resend ;; *) MAIL=none ;; esac
fi
MAIL="${MAIL:-keep}"
case "$MAIL" in
  smtp | resend)
    from_default="$(unquoted EMAIL_FROM)"
    [ -n "$from_default" ] || [ "$MODE" = lan ] || from_default="aprscaching <noreply@$DOMAIN_IN>"
    ask MAIL_FROM "Sender address (EMAIL_FROM)" "${MAIL_FROM:-$from_default}"
    [ -n "$MAIL_FROM" ] || { echo "A sender address is required (--email-from)." >&2; exit 2; }
    ;;
esac
case "$MAIL" in
  smtp)
    ask SMTP_HOST_IN "SMTP server (e.g. mail.example.net)" "${SMTP_HOST_IN:-$(current SMTP_HOST)}"
    [ -n "$SMTP_HOST_IN" ] || { echo "An SMTP server is required (--smtp-host)." >&2; exit 2; }
    ask SMTP_PORT_IN "SMTP port (587 for STARTTLS, 465 for TLS)" "${SMTP_PORT_IN:-$(current SMTP_PORT)}"
    SMTP_PORT_IN="${SMTP_PORT_IN:-587}"
    secure_default=starttls
    [ "$SMTP_PORT_IN" != 465 ] || secure_default=tls
    ask SMTP_SECURE_IN "Connection security: starttls, tls or none" "${SMTP_SECURE_IN:-$secure_default}"
    case "$SMTP_SECURE_IN" in starttls | tls | none) ;; *)
      echo "The connection security is starttls, tls or none (--smtp-secure)." >&2
      exit 2
      ;;
    esac
    # A hosted mailbox logs in with the full address: offer the sender's own, "-" for none.
    user_default="${SMTP_USER_IN:-$(unquoted SMTP_USER)}"
    [ -n "$user_default" ] || [ "$INTERACTIVE" -eq 0 ] || user_default="$(printf '%s' "$MAIL_FROM" | sed -E 's/.*<([^>]*)>.*/\1/')"
    ask SMTP_USER_IN "SMTP login, often the full address (- = no login)" "$user_default"
    [ "$SMTP_USER_IN" != - ] || SMTP_USER_IN=""
    if [ -n "$SMTP_USER_IN" ]; then
      ask_secret SMTP_PASS_IN "SMTP password (blank = keep the current one)"
      [ -n "$SMTP_PASS_IN$(current SMTP_PASS)" ] || { echo "The SMTP login needs its password (--smtp-pass or SMTP_PASS)." >&2; exit 2; }
    fi
    ;;
  resend)
    ask_secret RESEND_KEY_IN "Resend API key (blank = keep the current one)"
    [ -n "$RESEND_KEY_IN$(current EMAIL_API_KEY)" ] || { echo "A Resend API key is required (--resend-key or EMAIL_API_KEY)." >&2; exit 2; }
    ;;
  none | keep) ;;
  *) echo "--mail is smtp, resend or none." >&2; exit 2 ;;
esac
for v in "$MAIL_FROM" "$SMTP_USER_IN" "$SMTP_PASS_IN" "$RESEND_KEY_IN"; do
  case "$v" in *"'"*)
    echo "A mail setting holds a single quote, which cannot be written here; put it into $ENV_FILE by hand." >&2
    exit 2
    ;;
  esac
done

# Further admin calls after the first stay as they are; only the first is this operator's answer.
admin_rest="$(printf '%s' "$existing_admin" | tr '[:lower:]' '[:upper:]' | tr ', ' '\n\n' | sed '1d' | { grep -vxF -e "$CALL" -e '' || true; } | paste -sd, -)"
# The receiving sites: this box's site first, then every other site already listed (a MeshCom node's call,
# a second TNC), so naming a new site replaces only the old one.
old_site="$(current RF_SITE_CALL | tr '[:lower:]' '[:upper:]')"
other_sites="$(current FIRST_PARTY_SITES | tr '[:lower:]' '[:upper:]' | tr ', ' '\n\n' | { grep -vxF -e "${old_site:-}" -e "$SITE" -e '' || true; } | paste -sd, -)"

# ---- write .env ----------------------------------------------------------------------------------------
echo "Writing $ENV_FILE"
setvar ADMIN_CALLSIGNS "$CALL${admin_rest:+,$admin_rest}"
setvar APRSIS_CALLSIGN "$CALL"
setvar APRSIS_PASSCODE "${PASS:--1}" secret
setvar APRSIS_FILTER "$FILTER"
setvar APP_URL "$APP_URL"
# DOMAIN (what Caddy serves) follows the public URL: it changes exactly when APP_URL does
[ "$WROTE" -eq 1 ] && write_line DOMAIN "$CADDY_DOMAIN"
[ "$MODE" = tunnel ] && setvar TUNNEL_TOKEN "$TUNNEL" secret
if [ "$EXTRA_IN" = - ]; then
  unset_var EXTRA_ORIGINS
elif [ -n "$EXTRA_IN" ]; then
  setvar EXTRA_ORIGINS "$EXTRA_IN"
fi
if [ -n "$SITE" ]; then
  # one receiving site, named on both sides: the ingest box stamps it, the gateway attests it
  setvar RF_SITE_CALL "$SITE"
  setvar FIRST_PARTY_SITES "$SITE${other_sites:+,$other_sites}"
fi
# The safe federation posture, written out so the operator sees it. A value the operator chose is kept,
# and an unsafe one is pointed out rather than replaced.
default_var() { [ -n "$(current "$1")" ] || { write_line "$1" "$2"; echo "  set $1=$2"; }; }
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
    # a 44Net name that is also an https address of the instance is published as https://<name>: peers try https
    # first and fall back to plain http on the same name
    net44_addr="$NET44_IN"
    case ",$EXTRA_IN,$(unquoted EXTRA_ORIGINS)," in *",https://$NET44_IN,"*) net44_addr="https://$NET44_IN" ;; esac
    # single-quoted, as compose and systemd both read a quoted JSON value intact
    setvar FED_ENDPOINTS "'[{\"transport\":\"https\",\"address\":\"$APP_URL\",\"priority\":10},{\"transport\":\"44net\",\"address\":\"$net44_addr\",\"priority\":20}]'"
    echo "  44Net: Instance admin -> Federation -> Publish your callsign identity shows the records to add (docs/run/networks/44net-identity.md)."
  fi
  case "$(current FED_DISCOVER)" in 1 | true | yes)
    echo "  WARN: FED_DISCOVER is on, so learned peers are added (disabled). Set it to 0 to turn discovery off." ;;
  esac
  case "$(current FED_AUTO_PROMOTE)" in 0 | "") ;; *) echo "  WARN: FED_AUTO_PROMOTE is not 0: peers can become trusted without you." ;; esac
  case "$(current FED_CORROBORATION_QUORUM)" in 0 | 1) echo "  WARN: FED_CORROBORATION_QUORUM below 2 lets one peer lift a find to Tier A." ;; esac
  if [ -n "$(current FED_PEERS)" ] && ! check_peers "$(current FED_PEERS)" 2>/dev/null; then
    echo "  WARN: FED_PEERS holds an https peer on 44Net or a malformed entry. Onboard 44Net peers from Instance admin."
  fi
fi
case "$MAIL" in
  smtp)
    setvar EMAIL_FROM "$(quoted "$MAIL_FROM")"
    setvar SMTP_HOST "$SMTP_HOST_IN"
    setvar SMTP_PORT "$SMTP_PORT_IN"
    setvar SMTP_SECURE "$SMTP_SECURE_IN"
    if [ -n "$SMTP_USER_IN" ]; then
      setvar SMTP_USER "$(quoted "$SMTP_USER_IN")"
      [ -z "$SMTP_PASS_IN" ] || setvar SMTP_PASS "$(quoted "$SMTP_PASS_IN")" secret
    else
      unset_var SMTP_USER
      unset_var SMTP_PASS
    fi
    ;;
  resend)
    setvar EMAIL_FROM "$(quoted "$MAIL_FROM")"
    [ -z "$RESEND_KEY_IN" ] || setvar EMAIL_API_KEY "$(quoted "$RESEND_KEY_IN")" secret
    unset_var SMTP_HOST # set, SMTP would carry the mail instead
    ;;
  none)
    unset_var SMTP_HOST
    unset_var EMAIL_API_KEY
    ;;
esac
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
if [ "$MODE" = lan ] && [ -z "$(current SMTP_HOST)$(current EMAIL_API_KEY)" ]; then
  cat <<EOF
     Plain http has no passkeys and this box sends no email, so sign in with a one-time link:
       docker compose exec gateway node tools/admin/signin-link.mjs $CALL
EOF
fi
cat <<EOF
  4. Verify:  docker compose exec gateway node tools/admin/verify-call.mjs $CALL
     This confirms your call with OPERATOR_SECRET and opens Instance admin (the Admin rail entry).
EOF
if [ -n "$(current EMAIL_FROM)" ] && [ -n "$(current SMTP_HOST)$(current EMAIL_API_KEY)" ]; then
  cat <<EOF
     Mail:    docker compose exec gateway node tools/admin/mail-test.mjs <your address>
     This sends one test mail and prints the mail server's answer when it is refused.
EOF
fi
cat <<EOF
  5. Finish:  Instance admin -> Setup ($APP_URL) lists what is left to configure, in order.
Keep OPERATOR_SECRET off any separate ingest box; that box needs only INGEST_SECRET.
EOF
