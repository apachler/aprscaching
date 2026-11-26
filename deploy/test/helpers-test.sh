#!/usr/bin/env bash
# Checks of the deploy helpers (deploy/aprscaching and deploy/lib/) that need no Docker, no network and no
# installed instance: the .env editing, the schema lookups, shape detection and the dispatcher's commands.
#
#   bash deploy/test/helpers-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
. "$DEPLOY/lib/common.sh"
# shellcheck source=deploy/lib/env.sh
. "$DEPLOY/lib/env.sh"
# shellcheck source=deploy/lib/config.sh
. "$DEPLOY/lib/config.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
ok() { printf 'ok   %s\n' "$1"; }
bad() {
  printf 'FAIL %s\n' "$1"
  FAILED=1
}
check() { # check "name" command…
  local name="$1"
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
eq() { [ "$1" = "$2" ] || { printf '     got: %s\n     want: %s\n' "$1" "$2"; return 1; }; }

# ---- .env editing ----------------------------------------------------------------------------------------
E="$TMP/a.env"
printf '# head comment\nAPRSIS_HOST=rotate.aprs2.net\n# a note\n# APP_URL=https://aprs.example.net\nTAIL=1\n' >"$E"
chmod 644 "$E"
env_file_set "$E" APRSIS_HOST euro.aprs2.net
env_file_set "$E" APP_URL https://aprs.oe8.net
env_file_set "$E" NEW_KEY 'a b=c'
check "set replaces the active line in place" eq "$(sed -n 2p "$E")" "APRSIS_HOST=euro.aprs2.net"
check "set fills the commented template line in place" eq "$(sed -n 4p "$E")" "APP_URL=https://aprs.oe8.net"
check "set appends a new key at the end" eq "$(tail -n 1 "$E")" "NEW_KEY=a b=c"
check "comments survive" eq "$(grep -c '^#' "$E")" "2"
check "the file becomes owner-only" eq "$(file_mode "$E")" "600"
check "get reads a value with = in it" eq "$(env_file_get "$E" NEW_KEY)" "a b=c"
printf 'Q="quoted"\n' >>"$E"
check "get strips quotes" eq "$(env_file_get "$E" Q)" "quoted"
env_file_unset "$E" NEW_KEY
check "unset removes the key" eq "$(env_file_get "$E" NEW_KEY)" ""
check "keys lists assignments in order" eq "$(env_file_keys "$E" | tr '\n' ' ')" "APRSIS_HOST APP_URL TAIL Q "
env_file_secure "$TMP/new.env"
check "secure creates a missing file owner-only" eq "$(file_mode "$TMP/new.env")" "600"
printf 'OPERATOR_NAME="Club Station OE8XYZ"\nRETENTION={"positions": 30}\n' >>"$E"
check "raw keeps the quotes a shell-sourced .env needs" eq "$(env_file_raw "$E" OPERATOR_NAME)" '"Club Station OE8XYZ"'
check "  … and JSON as written" eq "$(env_file_raw "$E" RETENTION)" '{"positions": 30}'

# ---- the deploy files: what reaches the image and the ingest ------------------------------------------------
# The gateway-only secrets: secret in the schema, and not read by the ingest.
GW_SECRETS="$(awk -F'\t' '!/^#/ && $6 == 1 && $3 !~ /ingest/ {print $1}' "$DEPLOY/lib/config-keys.tsv")"
blanks_all() { # blanks_all TEXT: every gateway-only secret is set to "" in TEXT
  local k missing=""
  for k in $GW_SECRETS; do grep -qE "^ +$k: \"\"\$" <<<"$1" || missing="$missing $k"; done
  eq "${missing:-none}" none
}
INGEST_SVC="$(sed -n '/^  ingest:/,/^  [a-z]*:/p' "$DEPLOY/docker-compose.yml")"
check "the stack's ingest blanks every gateway-only secret" blanks_all "$INGEST_SVC"
check "the ingest box blanks every gateway-only secret" blanks_all "$(cat "$DEPLOY/compose.ingest-only.yml")"
check "the ingest unit unsets every gateway-only secret" bash -c "u=\$(sed -n 's/^UnsetEnvironment=//p' '$DEPLOY/systemd/aprscaching-ingest.service'); for k in $(echo $GW_SECRETS); do [[ \" \$u \" == *\" \$k \"* ]] || exit 1; done"
check "the ingest's settings come from .env, not as empty \${KEY} strings" \
  bash -c "! grep -v '^ *#' <<<\"\$1\$2\" | grep -E '\\\$\\{[A-Z_]+(:-)?\\}'" _"$INGEST_SVC" "$(cat "$DEPLOY/compose.ingest-only.yml")"
check "the image runs as UID 10001, not as root" grep -qx 'USER 10001' "$DEPLOY/Dockerfile"
check "  … which owns /data and /srv/web" grep -q 'chown -R 10001:10001 /data /srv/web' "$DEPLOY/Dockerfile"
check "  … and is the UID the helper hands the volumes to" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; [ \"\$SELFHOST_UID\" = 10001 ]"
check "the tunnel overlay resets Caddy's ports" grep -qE '^    ports: !reset \[\]' "$DEPLOY/compose.home.yml"
# Every image the stack pulls is pinned by version and multi-arch index digest, and Dependabot reads the files
# that name them; the image the stack builds itself (aprscaching:local) is the one exception.
IMAGES="$(sed -n -E 's/^ +image: *//p' "$DEPLOY"/*.yml | grep -vx 'aprscaching:local' || true)"
check "the stack pulls images" test -n "$IMAGES"
check "  … each pinned by version and index digest" bash -c "! grep -vE '^[a-z0-9./-]+:[0-9][0-9.]*(-[a-z0-9]+)?@sha256:[0-9a-f]{64}\$' <<<\"\$1\"" _ "$IMAGES"
check "  … and Dependabot refreshes the compose files that name them" \
  bash -c "awk '/package-ecosystem: docker-compose/ { on = 1 } on && /\"\/deploy\"/ { found = 1 } END { exit !found }' '$DEPLOY/../.github/dependabot.yml'"
for p in '**/.env' '**/.env.*' '!**/*.example' '**/*.secret' 'deploy/.shape' 'deploy/backups' '**/data' '**/*.db'; do
  check "the image leaves out $p" grep -qxF -- "$p" "$DEPLOY/../.dockerignore"
done
check "Compose 2.24 is new enough" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; selfhost_compose_supported 2.24.0 && selfhost_compose_supported v2.29.1 && selfhost_compose_supported 5.4.0"
check "  … 2.23 is not" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; ! selfhost_compose_supported 2.23.3"
CFG=$'services:\n  caddy:\n    image: caddy:2\n    ports:\n      - target: 80\n  gateway:\n    image: x\nvolumes:\n  caddy: {}\n'
check "a merged config that publishes Caddy's ports is found" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; selfhost_publishes caddy <<<\"\$1\"" _ "$CFG"
check "  … and one without them is not" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; ! selfhost_publishes gateway <<<\"\$1\"" _ "$CFG"
if have docker && docker compose version >/dev/null 2>&1; then
  merged() { (cd "$DEPLOY" && TUNNEL_TOKEN=t INGEST_SECRET=s docker compose --env-file /dev/null "$@" config 2>/dev/null); }
  check "with the tunnel overlay, Caddy publishes no port" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; ! selfhost_publishes caddy <<<\"\$1\"" _ \
    "$(merged -f docker-compose.yml -f compose.home.yml)"
  check "  … without it, 80 and 443" bash -c ". '$DEPLOY/lib/shapes/selfhost.sh'; selfhost_publishes caddy <<<\"\$1\"" _ "$(merged -f docker-compose.yml)"
  check "without CF_RANGES, Caddy passes every address's cf-connecting-ip" \
    grep -qE "^ +CF_RANGES: 0\.0\.0\.0/0 ::/0\$" <<<"$(merged -f docker-compose.yml)"
  check "  … with the tunnel overlay, only the stack network's" \
    grep -qE "^ +CF_RANGES: private_ranges\$" <<<"$(merged -f docker-compose.yml -f compose.home.yml)"
else
  echo "skip the merged compose configuration (needs docker compose)"
fi

# ---- the schema --------------------------------------------------------------------------------------------
check "a schema key is known" cfg_known KISS_TNC_PORT
check "a typo is not" bash -c ". '$DEPLOY/lib/config.sh'; ! cfg_known KISS_TNC_PRT"
check "INGEST_SECRET is a secret" cfg_secret INGEST_SECRET
check "APRSIS_HOST is not" bash -c ". '$DEPLOY/lib/config.sh'; ! cfg_secret APRSIS_HOST"
check "a default comes from the schema" eq "$(cfg_default KISS_TNC_PORT)" "8001"
check "a hint is one line" eq "$(cfg_hint KISS_TNC_PORT | wc -l | tr -d ' ')" "1"
check "an ingest box reads the TNC settings" bash -c ". '$DEPLOY/lib/config.sh'; cfg_keys_for ingest-box | grep -qx KISS_TNC_HOST"
check "an ingest box does not read APP_URL" bash -c ". '$DEPLOY/lib/config.sh'; ! cfg_keys_for ingest-box | grep -qx APP_URL"
check "a public instance must set APP_URL" bash -c ". '$DEPLOY/lib/config.sh'; cfg_keys_for selfhost 1 | grep -qx APP_URL"
check "a whole number passes" cfg_check KISS_TNC_PORT 8001
check "a blank value passes" cfg_check KISS_TNC_PORT "  "
check "a word fails as a number" eq "$(cfg_check KISS_TNC_PORT eighty || true)" "KISS_TNC_PORT: expected a whole number"
check "a fraction passes as a number" cfg_check MESHCOM_RATE 2.5
check "an enum value passes" cfg_check TRUST_CF 1
check "a callsign with an SSID passes" cfg_check DIGI_CALL OE8APR-10
check "a callsign with an SSID over 15 fails" eq "$(cfg_check DIGI_CALL OE8APR-20 || true)" "DIGI_CALL: expected a callsign such as OE8APR-10 (SSID 0-15)"
check "a word without a digit fails as a callsign" eq "$(cfg_check SERVICE_CALL APRSCG || true)" "SERVICE_CALL: expected a callsign such as OE8APR-10 (SSID 0-15)"
check "a list of callsigns passes, a MeshCom SSID too" cfg_check FIRST_PARTY_SITES "OE8APR-10, OE8APR-42"
check "a list with a non-callsign fails" eq "$(cfg_check FIRST_PARTY_SITES "OE8APR-10,nope" || true)" "FIRST_PARTY_SITES: expected callsigns such as OE8APR,OE8APR-10, separated by commas"
check "an unknown enum value fails" eq "$(cfg_check TRUST_CF true || true)" "TRUST_CF: expected one of: 0, 1"
check "a URL passes" cfg_check APP_URL https://aprs.example.net
check "a bare host fails as a URL" eq "$(cfg_check APP_URL aprs.example.net || true)" "APP_URL: expected an absolute URL"
if have node || have python3; then
  check "broken JSON fails" eq "$(cfg_check FED_KEY_HISTORY '[{' || true)" "FED_KEY_HISTORY: expected valid JSON"
  check "JSON passes" cfg_check FED_KEY_HISTORY '[]'
fi
check "origins pass, https and http, a name or a 44.x address" cfg_check EXTRA_ORIGINS "https://aprscaching.oe8apr.ampr.org,http://44.143.1.2:8080"
check "an origin with a path fails" eq "$(cfg_check EXTRA_ORIGINS "https://a.example/app" || true)" \
  "EXTRA_ORIGINS: expected origins such as https://aprs.example.net,http://44.143.1.2, separated by commas (no path)"
check "a failure never shows the value" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/config.sh'; ! cfg_check APP_URL s3cr3t-value | grep -q s3cr3t"

# ---- questions ---------------------------------------------------------------------------------------------
check "non-interactive ask takes the default" bash -c \
  "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; ask V q dflt; [ \"\$V\" = dflt ]"
if bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; ask V 'Your call' '' --call" 2>"$TMP/err"; then
  bad "non-interactive ask without a required value fails"
else
  ok "non-interactive ask without a required value fails"
fi
check "  … and names the flag" grep -q -- "--call" "$TMP/err"
check "non-interactive confirm says no" bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; ! confirm q </dev/null"
check "--yes confirms" bash -c "APRS_ASSUME_YES=1; . '$DEPLOY/lib/common.sh'; confirm q"
check "a generated secret is 48 hex characters" bash -c ". '$DEPLOY/lib/common.sh'; [[ \"\$(gen_secret)\" =~ ^[0-9a-f]{48}\$ ]]"
check "json_str escapes" eq "$(json_str "a\"b\\c")" '"a\"b\\c"'

# ---- shapes and the dispatcher -----------------------------------------------------------------------------
H="$DEPLOY/aprscaching"
export APRSCACHING_SHAPE_FILE="$TMP/shape"
export APRSCACHING_DATA="$TMP/no-pocket" # a Pocket .env in this user's home must not decide the shape
run() { "$H" "$@" </dev/null >"$TMP/out" 2>"$TMP/err"; }

check "help prints the commands" bash -c "'$H' help | grep -q 'rotate-secret'"
for c in status doctor update backup restore rotate-secret; do
  check "$c --help prints its usage, with nothing installed" bash -c "'$H' $c --help | grep -q '^deploy/aprscaching $c'"
done
check "an unknown command fails" bash -c "! '$H' frob 2>/dev/null"
check "an unknown shape fails" bash -c "! '$H' init mainframe 2>/dev/null"
check "a shape without a command explains it" bash -c "'$H' --shape ingest-box restore x.tar.gz 2>&1 | grep -q 'not available for the ingest-box shape'"
check "status --json is JSON" bash -c "'$H' --shape desktop --json status | node -e 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"))' 2>/dev/null || ! have node"

E2="$TMP/selfhost.env"
printf 'INGEST_SECRET=old-ingest\nSESSION_SECRET=old-session\nADMIN_CALLSIGNS=OE8APR\n' >"$E2"
printf 'shape=selfhost\nenv=%s\n' "$E2" >"$APRSCACHING_SHAPE_FILE"
if run --non-interactive rotate-secret INGEST_SECRET; then bad "rotation without --yes is refused"; else ok "rotation without --yes is refused"; fi
check "  … and keeps the value" eq "$(env_file_get "$E2" INGEST_SECRET)" "old-ingest"
check "rotate INGEST_SECRET with --yes" run --yes rotate-secret INGEST_SECRET
NEW="$(env_file_get "$E2" INGEST_SECRET)"
is_fresh() { [ "$NEW" != old-ingest ] && [[ "$NEW" =~ ^[0-9a-f]{48}$ ]]; }
check "  … writes a fresh value into the recorded .env" is_fresh
check "  … shows it once, for the ingest boxes" grep -q "$NEW" "$TMP/out"
check "  … keeps the file owner-only" eq "$(file_mode "$E2")" "600"
check "rotate SESSION_SECRET" run --yes rotate-secret SESSION_SECRET
check "  … never prints it" bash -c "! grep -q '$(env_file_get "$E2" SESSION_SECRET)' '$TMP/out' '$TMP/err'"
check "the federation key is not rotated here" bash -c "'$H' --yes rotate-secret FED_PRIVATE_KEY 2>&1 | grep -q rotatekey.mjs"

rm -f "$APRSCACHING_SHAPE_FILE"
mkdir -p "$TMP/d/lib"
cp "$DEPLOY/lib/shape.sh" "$TMP/d/lib/"
probe() { DEPLOY_DIR="$TMP/d" bash -c ". '$TMP/d/lib/shape.sh'; shape_probe"; }
printf 'ADMIN_CALLSIGNS=OE8APR\nINGEST_SECRET=x\n' >"$TMP/d/.env"
check "a .env with operator settings is a self-host gateway" eq "$(probe)" "selfhost"
printf 'INGEST_URL=https://gw.example/ingest\nINGEST_SECRET=x\n' >"$TMP/d/.env"
check "a .env with only the ingest link is an ingest box" eq "$(probe)" "ingest-box"

# ---- doctor: where a further address lies ---------------------------------------------------------------------
scope() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/config.sh'; . '$DEPLOY/lib/doctor.sh'; origin_scope \"\$1\"" _ "$1"; }
check "an address in 44.128.0.0/10 is 44Net, never HAMNET by range" eq "$(scope 44.143.1.2)" 44net
check "an address in 44.0.0.0/9 is 44Net" eq "$(scope 44.27.132.9)" 44net
check "an address in 44.192.0.0/10 is public, not 44Net" eq "$(scope 44.200.1.2)" public
check "a LAN address is private" eq "$(scope 192.168.1.10)" private
check "a CGNAT address is private" eq "$(scope 100.64.0.1)" private
check "a public address is public" eq "$(scope 203.0.113.7)" public
ampr() { bash -c ". '$DEPLOY/lib/common.sh'; ampr_scope \"\$1\"" _ "$1"; }
check "44.0.0.0/9 is 44Net" eq "$(ampr 44.27.132.9)" 44net
check "44.128.0.0/10 is 44Net" eq "$(ampr 44.143.1.2)" 44net
check "  … an internet-announced subnet in it as well" eq "$(ampr 44.135.208.1)" 44net
check "44.192.0.0/10 was sold and is not 44Net" eq "$(ampr 44.200.1.2)" sold
check "an address outside 44/8 is not 44Net" eq "$(ampr 144.44.1.2)" other

# ---- doctor: passkeys on a further address --------------------------------------------------------------------
rpid() { env -i PATH="$PATH" "$@" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/doctor.sh'; doc_rp_id"; }
check "the relying party is RP_ID when it is set" eq "$(rpid RP_ID=Example.NET APP_URL=https://aprs.example.org)" example.net
check "  … else APP_URL's host" eq "$(rpid APP_URL=https://aprscaching.net/)" aprscaching.net
check "  … else, under a plain-http APP_URL, the first https further address" \
  eq "$(rpid APP_URL=http://44.143.1.2 EXTRA_ORIGINS=http://lan.example,https://aprscaching.oe8apr.ampr.org)" aprscaching.oe8apr.ampr.org
# related ORIGIN HOST RP BODY: the check's status with the related-origins file stubbed (BODY empty: no answer)
related() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; DOCS_URL=x
  curl() { [ -n \"\$BODY\" ] || return 22; printf '%s' \"\$BODY\"; }
  doc_related_origin \"\$1\" \"\$2\" \"\$3\"; printf '%s' \"\${DOC_ROWS[*]}\" | cut -f1,2" _ "$1" "$2" "$3"; }
ROR='{"origins":["https://aprscaching.net","https://aprscaching.oe8apr.ampr.org"]}'
check "a further address listed in RP_ID's related-origins file passes" \
  eq "$(BODY="$ROR" related https://aprscaching.oe8apr.ampr.org aprscaching.oe8apr.ampr.org aprscaching.net)" $'pass\torigins.webauthn'
check "  … one missing from it fails" \
  eq "$(BODY='{"origins":["https://aprscaching.net"]}' related https://aprscaching.oe8apr.ampr.org aprscaching.oe8apr.ampr.org aprscaching.net)" $'fail\torigins.webauthn'
check "  … as does a file that does not answer" \
  eq "$(BODY='' related https://aprscaching.oe8apr.ampr.org aprscaching.oe8apr.ampr.org aprscaching.net)" $'fail\torigins.webauthn'
check "an address inside RP_ID's domain needs no file" \
  eq "$(BODY='' related https://www.aprscaching.net www.aprscaching.net aprscaching.net)" ""

# ---- setup.sh: the federation posture ---------------------------------------------------------------------
S="$DEPLOY/setup.sh"
setup() { "$S" --non-interactive --no-network "$@" </dev/null >"$TMP/out" 2>"$TMP/err"; }
P="$TMP/pub.env"
check "a public instance is set up" setup --env-file "$P" --call OE8APR --domain aprs.example.net \
  --fed-peers https://peer.example.org --net44-name aprscaching.oe8apr.ampr.org
check "  … in an owner-only .env" eq "$(file_mode "$P")" 600
check "  … with auto-promotion off" eq "$(env_file_get "$P" FED_AUTO_PROMOTE)" "0"
check "  … with a corroboration quorum of 2" eq "$(env_file_get "$P" FED_CORROBORATION_QUORUM)" "2"
check "  … with the peers it was given" eq "$(env_file_get "$P" FED_PEERS)" "https://peer.example.org"
check "  … with its 44Net endpoint beside https" bash -c "grep -q '\"44net\",\"address\":\"aprscaching.oe8apr.ampr.org\"' '$P'"
if setup --env-file "$TMP/b44.env" --call OE8APR --domain a.example.net --net44-name oe8apr.ampr.org; then
  bad "the base name <call>.ampr.org is refused as the 44Net name"
else
  ok "the base name <call>.ampr.org is refused as the 44Net name"
fi
if setup --env-file "$TMP/x.env" --call OE8APR --domain a.example.net --fed-peers https://gw.oe1xyz.ampr.org; then
  bad "a 44Net peer is refused for FED_PEERS"
else
  ok "a 44Net peer is refused for FED_PEERS"
fi
if setup --env-file "$TMP/x.env" --call OE8APR --domain a.example.net --fed-peers 'https://gw.oe1xyz.ampr.org#AAAA-BBBB-CCCC-DDDD'; then
  bad "a 44Net peer with a pinned fingerprint is refused for FED_PEERS"
else
  ok "a 44Net peer with a pinned fingerprint is refused for FED_PEERS"
fi
for a in 44.27.132.9 44.143.1.2; do
  if setup --env-file "$TMP/x.env" --call OE8APR --domain a.example.net --fed-peers "https://$a"; then
    bad "an https peer at the 44Net address $a is refused for FED_PEERS"
  else
    check "an https peer at the 44Net address $a is refused for FED_PEERS" grep -q "is on 44Net" "$TMP/err"
  fi
done
if setup --env-file "$TMP/x.env" --call OE8APR --domain a.example.net --fed-peers https://44.200.1.2; then
  ok "an address in 44.192.0.0/10 is not 44Net"
else
  bad "an address in 44.192.0.0/10 is not 44Net"
fi
HN="$TMP/hamnet.env"
check "a HAMNET peer at a plain http address, with a port and a pinned fingerprint, is taken" \
  setup --env-file "$HN" --call OE8APR --domain a.example.net \
  --fed-peers 'http://44.143.1.2:8080#3f2a9c01bb7e4d10,http://gw.oe8xyz.ampr.org,https://peer.example.org'
check "  … and written as given" eq "$(env_file_get "$HN" FED_PEERS)" \
  "http://44.143.1.2:8080#3f2a9c01bb7e4d10,http://gw.oe8xyz.ampr.org,https://peer.example.org"
check "  … with no warning about it" bash -c "! grep -q 'WARN: FED_PEERS' '$TMP/out'"
check "a LAN peer at a plain http address is taken" setup --env-file "$TMP/lan-peer.env" --call OE8APR \
  --domain a.example.net --fed-peers http://10.0.0.5:8787
if setup --env-file "$TMP/y.env" --call OE8APR --domain a.example.net --fed-peers http://peer.example.org/aprs; then
  bad "a plain-http peer with a path is refused"
else
  check "a plain-http peer with a path is refused" grep -q "http://<name or address>" "$TMP/err"
fi
if setup --env-file "$TMP/y.env" --call OE8APR --domain a.example.net --fed-peers ftp://peer.example.org; then
  bad "a peer that is neither https nor http is refused"
else
  ok "a peer that is neither https nor http is refused"
fi
cp "$P" "$TMP/hub.env"
echo "FED_SUBMIT_SECRET=s" >>"$TMP/hub.env"
if setup --env-file "$TMP/hub.env" --call OE8APR --domain aprs.example.net --fed-peers ""; then
  bad "a hub without its spoke list is refused"
else
  ok "a hub without its spoke list is refused"
fi
check "a hub takes its spoke list" setup --env-file "$TMP/hub.env" --call OE8APR --domain aprs.example.net \
  --fed-peers "" --fed-submit-instances spoke.example.org
check "  … and writes it" eq "$(env_file_get "$TMP/hub.env" FED_SUBMIT_INSTANCES)" "spoke.example.org"
env_file_set "$P" FED_AUTO_PROMOTE 3
check "a re-run keeps the operator's own choice" setup --env-file "$P" --call OE8APR --domain aprs.example.net --fed-peers ""
check "  … unchanged" eq "$(env_file_get "$P" FED_AUTO_PROMOTE)" "3"
check "  … and warns about it" grep -q "FED_AUTO_PROMOTE is not 0" "$TMP/out"
X="$TMP/extra.env"
check "setup writes the further addresses" setup --env-file "$X" --call OE8APR --domain aprs.example.net --fed-peers "" \
  --extra-origins "HTTPS://aprscaching.oe8apr.ampr.org/, http://44.143.1.2,https://aprs.example.net" \
  --net44-name aprscaching.oe8apr.ampr.org
check "  … normalised, without APP_URL's own" eq "$(env_file_get "$X" EXTRA_ORIGINS)" \
  "https://aprscaching.oe8apr.ampr.org,http://44.143.1.2"
check "  … and publishes the 44Net name with a certificate as https://<name>" \
  bash -c "grep -q '\"44net\",\"address\":\"https://aprscaching.oe8apr.ampr.org\"' '$X'"
if setup --env-file "$TMP/xbad.env" --call OE8APR --domain aprs.example.net --fed-peers "" --extra-origins "http://44.143.1.2/app"; then
  bad "an address with a path is refused"
else
  ok "an address with a path is refused"
fi
check "  … and the refusal names it" grep -q "http://44.143.1.2/app" "$TMP/err"
check "\"-\" removes the further addresses" setup --env-file "$X" --call OE8APR --domain aprs.example.net --fed-peers "" \
  --extra-origins -
check "  … from the .env" eq "$(env_file_get "$X" EXTRA_ORIGINS)" ""
L="$TMP/lan.env"
check "a LAN instance is set up" setup --env-file "$L" --call OE8APR --lan-host 10.0.0.5 --app-port 8080
check "  … on its own port" eq "$(env_file_get "$L" APP_URL)" "http://10.0.0.5:8080"
check "  … with no federation peers" eq "$(env_file_get "$L" FED_PEERS)" ""
M="$TMP/mail.env"
export SMTP_PASS=mailbox-pw # the password from the environment, off the command line
check "mail over SMTP is set up" setup --env-file "$M" --call OE8APR --domain aprs.example.net --fed-peers "" \
  --mail smtp --email-from "APRScaching <noreply@aprs.example.net>" --smtp-host mail.example.net \
  --smtp-user noreply@aprs.example.net
unset SMTP_PASS
check "  … names the mail test" grep -q "tools/admin/mail-test.mjs" "$TMP/out"
check "  … and shows no password" bash -c "! grep -q mailbox-pw '$TMP/out' '$TMP/err'"
check "  … with its server" eq "$(env_file_get "$M" SMTP_HOST)" "mail.example.net"
check "  … on port 587" eq "$(env_file_get "$M" SMTP_PORT)" "587"
check "  … over STARTTLS" eq "$(env_file_get "$M" SMTP_SECURE)" "starttls"
check "  … logging in as the address" eq "$(env_file_get "$M" SMTP_USER)" "noreply@aprs.example.net"
check "  … with the password from the environment" eq "$(env_file_get "$M" SMTP_PASS)" "mailbox-pw"
check "  … and the sender" eq "$(env_file_get "$M" EMAIL_FROM)" "APRScaching <noreply@aprs.example.net>"
check "a re-run without --mail keeps it" setup --env-file "$M" --call OE8APR --domain aprs.example.net --fed-peers ""
check "  … unchanged" eq "$(env_file_get "$M" SMTP_HOST)" "mail.example.net"
check "port 465 is TLS from the first byte" setup --env-file "$TMP/m465.env" --call OE8APR --domain aprs.example.net \
  --fed-peers "" --mail smtp --email-from noreply@aprs.example.net --smtp-host mail.example.net --smtp-port 465 --smtp-user -
check "  … tls" eq "$(env_file_get "$TMP/m465.env" SMTP_SECURE)" "tls"
check "  … and no login" eq "$(env_file_get "$TMP/m465.env" SMTP_USER)" ""
if setup --env-file "$TMP/mbad.env" --call OE8APR --domain a.example.net --fed-peers "" --mail smtp \
  --email-from a@a.example.net --smtp-host h --smtp-secure ssl; then
  bad "an unknown connection security is refused"
else
  ok "an unknown connection security is refused"
fi
check "switching to Resend" setup --yes --env-file "$M" --call OE8APR --domain aprs.example.net --fed-peers "" \
  --mail resend --resend-key re_test_key
check "  … writes its key" eq "$(env_file_get "$M" EMAIL_API_KEY)" "re_test_key"
check "  … and turns SMTP off, which would win" eq "$(env_file_get "$M" SMTP_HOST)" ""
check "no mail turns both off" setup --env-file "$M" --call OE8APR --domain aprs.example.net --fed-peers "" --mail none
check "  … Resend too" eq "$(env_file_get "$M" EMAIL_API_KEY)" ""
if setup --env-file "$TMP/t.env" --call OE8APR --domain a.example.net --tunnel-token t --no-tunnel; then
  bad "--no-tunnel refuses a tunnel token"
else
  ok "--no-tunnel refuses a tunnel token"
fi
check "--no-next-steps prints no Docker steps" bash -c "! '$S' --non-interactive --no-network --env-file '$L' --call OE8APR --lan-host 10.0.0.5 --no-next-steps </dev/null | grep -q 'docker compose'"

# ---- bare metal ------------------------------------------------------------------------------------------------
if have systemctl && have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  check "bare metal: a dry run" run --yes init baremetal --dry-run --ref main --unverified --dir /srv/acs --user acs --port 8090 --call OE8APR
  check "  … lists the root steps first" grep -q "Steps that need root" "$TMP/out"
  check "  … creates the user as root" grep -q "\[root\] useradd --system .* acs$" "$TMP/out"
  check "  … and the build user" grep -q "\[root\] useradd --system .* acs-build$" "$TMP/out"
  check "  … creates the install directory root's" grep -qx "    \[root\] install -d -o root -g root -m 755 /srv/acs" "$TMP/out"
  check "  … clones as root" grep -q "\[root\] git clone" "$TMP/out"
  check "  … writes the .env as root, through setup.sh on its port" grep -q "\[root\] bash /srv/acs/deploy/setup.sh --env-file /srv/acs/deploy/.env --app-port 8090 --no-tunnel" "$TMP/out"
  check "  … enables both units" grep -q "systemctl enable --now aprscaching-gateway aprscaching-ingest" "$TMP/out"
  check "  … makes data/ the service user's alone" grep -qx "    \[root\] install -d -o acs -g acs -m 700 /srv/acs/data" "$TMP/out"
  check "  … builds as the build user, with its own store" grep -qF "[acs-build] bash -c umask 022 && cd '/srv/acs' && corepack pnpm install --frozen-lockfile --store-dir \"\$HOME/.local/share/pnpm/store\" &&" "$TMP/out"
  check "  … the web app too" grep -qx "    corepack pnpm --filter @aprscaching/web build" "$TMP/out"
  # The service user writes nothing in the checkout but data/: every directory it is given is data/, and every
  # step it runs is the one that fetches pnpm into its own home.
  check "  … gives the service user data/ alone" bash -c "! grep -E -- '-o acs ' '$TMP/out' | grep -v ' /srv/acs/data\$'"
  check "  … and runs nothing as it in the checkout" bash -c "! grep -F '[acs] ' '$TMP/out' | grep -vF \"[acs] bash -c cd '/srv/acs' && corepack pnpm --version >/dev/null\""
  # The build user may write the build's outputs alone, each workspace package's node_modules and the web build.
  check "  … gives the build user the build's outputs alone" bash -c "! grep -E -- '-o acs-build ' '$TMP/out' | grep -vE ' /srv/acs/(node_modules|[a-z]+/[a-z0-9_-]+/node_modules|apps/web/dist)\$'"
  check "  … the web build's output among them" grep -qx "    \[root\] install -d -o acs-build -g acs-build -m 755 /srv/acs/apps/web/dist" "$TMP/out"
  for pkg in "$DEPLOY"/../packages/*/package.json "$DEPLOY"/../apps/*/package.json; do
    pkg="$(basename "$(dirname "$(dirname "$pkg")")")/$(basename "$(dirname "$pkg")")"
    grep -qx "    \[root\] install -d -o acs-build -g acs-build -m 755 /srv/acs/$pkg/node_modules" "$TMP/out" ||
      bad "  … $pkg/node_modules for the build user"
  done
  check "  … says the checkout is unverified" grep -q "main (branch) is not verified" "$TMP/err"
  check "  … records nothing" test ! -e "$APRSCACHING_SHAPE_FILE"
  check "bare metal: --no-start leaves systemd alone" run --yes init baremetal --dry-run --ref main --unverified --no-start --call OE8APR
  check "  … no systemctl" bash -c "! grep -q '\[root\] systemctl' '$TMP/out'"
  if run --non-interactive init baremetal --dry-run --ref main --call OE8APR; then
    bad "bare metal: an unverified install without --yes is refused"
  else
    ok "bare metal: an unverified install without --yes is refused"
  fi
else
  echo "skip bare metal (needs systemctl and Node.js 22+)"
fi
# The build's outputs follow pnpm-workspace.yaml: a package added there gets its node_modules.
BP="$TMP/bp"
mkdir -p "$BP/libs/a" "$BP/libs/b" "$BP/apps/web" "$BP/libs/notapkg"
printf '{}' >"$BP/libs/a/package.json"
printf '{}' >"$BP/libs/b/package.json"
printf '{}' >"$BP/apps/web/package.json"
printf 'packages:\n  - "libs/*"\n  - apps/*\n\n# a note\nonlyBuiltDependencies:\n  - esbuild\n' >"$BP/pnpm-workspace.yaml"
check "the build's outputs are read from the workspace's packages" eq \
  "$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; bm_build_paths '$BP'" | tr '\n' ' ')" \
  "node_modules libs/a/node_modules libs/b/node_modules apps/web/node_modules apps/web/dist "

# update on a checkout the service user owns hands it to root before the build: the build outputs it wrote
# are removed, everything but data/ becomes root's; one root already owns is built as it is. root, the
# service user and the build user are stand-ins that log what they would run.
bm_update_case() { # bm_update_case OWNER [BUILD_RC]: shape_update_apply with the checkout's owner OWNER
  local d="$TMP/bmup/$1" build_rc="${2:-0}"
  mkdir -p "$d/deploy" "$d/.git" "$d/data" "$d/apps/web" "$d/units"
  printf 'packages:\n  - "apps/*"\n' >"$d/pnpm-workspace.yaml"
  printf '{}' >"$d/apps/web/package.json"
  printf 'X=1\n' >"$d/deploy/.env"
  printf '[Service]\nUser=acs\n' >"$d/units/aprscaching-gateway.service"
  bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'
    SHAPE_ENV='$d/deploy/.env' BM_UNIT_DIR='$d/units'
    bm_checkout_is_service_users() { [ '$1' != root ]; }
    bm_owner() { echo '$1'; }
    bm_root() { echo \"[root] \$*\"; }
    bm_user() { echo \"[\$BM_USER] \$*\"; }
    bm_build() { echo \"[\$BM_BUILDER] \$*\"; return $build_rc; }
    shape_update_apply" >"$TMP/bmup.out" 2>&1
}
bm_update_case acs
check "update hands a checkout the service user owns to root" grep -qx "\[root\] chown root:root $TMP/bmup/acs" "$TMP/bmup.out"
check "  … everything in it but data/" grep -qx "\[root\] find $TMP/bmup/acs -mindepth 1 -path $TMP/bmup/acs/data -prune -o -exec chown -h root:root {} +" "$TMP/bmup.out"
check "  … and takes the write bits a mode or an ACL left to others" grep -qx "\[root\] find $TMP/bmup/acs -mindepth 1 -path $TMP/bmup/acs/data -prune -o ! -type l -exec chmod go-w {} +" "$TMP/bmup.out"
check "  … and records the commit it built" grep -q "^\[root\] sh -c .* $TMP/bmup/acs $TMP/bmup/acs/.git/aprscaching-built\$" "$TMP/bmup.out"
check "  … removes the build outputs the service user wrote" bash -c "grep -qx '\[root\] rm -rf $TMP/bmup/acs/node_modules' '$TMP/bmup.out' && grep -qx '\[root\] rm -rf $TMP/bmup/acs/apps/web/dist' '$TMP/bmup.out'"
check "  … before it builds, as the build user the unit's user names" bash -c "grep -n '' '$TMP/bmup.out' | awk -F: '/chown root:root/ { c = \$1 } /\[acs-build\] bash -c umask 022/ { b = \$1 } END { exit !(c && b && c < b) }'"
check "  … and runs git as root from then on" bash -c "SHAPE_ENV='$TMP/bmup/acs/deploy/.env'; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'
  BM_UNIT_DIR='$TMP/bmup/acs/units'; bm_owner() { echo root; }; bm_root() { echo \"[root] \$*\"; }; shape_git status | grep -q '^\[root\] sh -c .* git -C $TMP/bmup/acs status'"
check "update runs git as the service user in a checkout not yet handed over" bash -c "SHAPE_ENV='$TMP/bmup/acs/deploy/.env'; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'
  BM_UNIT_DIR='$TMP/bmup/acs/units'; bm_owner() { echo acs; }; bm_user() { echo \"[\$BM_USER] \$*\"; }; shape_git status | grep -qx '\[acs\] git -C $TMP/bmup/acs status'"
bm_update_case root
check "update leaves a checkout root owns where it is" bash -c "! grep -qE 'chown|rm -rf' '$TMP/bmup.out'"
check "  … and builds as the build user" grep -q "^\[acs-build\] bash -c umask 022" "$TMP/bmup.out"
bm_update_case root 1 || true
check "a failed build records no commit, so the next update owes it" bash -c "grep -q '^\[acs-build\] bash -c umask 022' '$TMP/bmup.out' && ! grep -q aprscaching-built '$TMP/bmup.out'"

# The hand-over itself, on a real tree that the user running this test owns, standing in for the service user;
# root's chown is left out, since only root may give a file away. A symbolic link at the top and one inside point
# out of the checkout: chmod must change neither target. data/ keeps its modes.
HO="$TMP/handover"
mkdir -p "$HO/co/.git" "$HO/co/deploy/lib" "$HO/co/data" "$HO/outside/sub"
printf 'packages:\n' >"$HO/co/pnpm-workspace.yaml"
touch "$HO/co/deploy/lib/common.sh" "$HO/co/data/f"
ln -s "$HO/outside" "$HO/co/lnk"
ln -s "$HO/outside/sub" "$HO/co/deploy/inner"
chmod 777 "$HO/outside" "$HO/outside/sub" "$HO/co/deploy/lib"
chmod 666 "$HO/co/deploy/lib/common.sh" "$HO/co/data/f"
bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DRY=0 BM_DIR='$HO/co' BM_USER=\$(id -un)
  bm_root() { case \"\$1 \$*\" in chown*|*'-exec chown'*) return 0 ;; esac; \"\$@\"; }
  bm_take_checkout" >"$TMP/handover.out" 2>&1
check "the hand-over takes others' write bits in the checkout" eq "$(stat -c %a "$HO/co/deploy/lib/common.sh") $(stat -c %a "$HO/co/deploy/lib")" "644 755"
check "  … follows no symbolic link out of it" eq "$(stat -c %a "$HO/outside") $(stat -c %a "$HO/outside/sub")" "777 777"
check "  … and leaves data/ as it is" eq "$(stat -c %a "$HO/co/data/f")" 666
# What counts as the service user's: anything outside data/, and nothing inside it.
check "the service user's paths are the checkout's, not data/'s" eq \
  "$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DIR='$HO/co' BM_USER=\$(id -un); bm_service_owned" | grep -c "^$HO/co/data") \
$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DIR='$HO/co' BM_USER=\$(id -un); bm_service_owned" | grep -cx "$HO/co/deploy/lib/common.sh")" "0 1"

# ---- release verification: init baremetal and update, through the one check in deploy/lib/release.sh --------------
# deploy/test/release-case.sh runs one case through one caller, with curl and gh standing in for GitHub.
FIX="$TMP/relfix"
mkdir -p "$FIX/rel" "$FIX/rel-moved" "$FIX/rel-notag"
(
  g() { git -c user.name=t -c user.email=t@example.org -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
  cd "$FIX" && git init --quiet -b main src && cd src
  g commit --quiet --allow-empty -m one && g tag v1.0.0
  g commit --quiet --allow-empty -m two && g tag -a -m v1.1.0 v1.1.0
  git clone --quiet --bare . "$FIX/origin.git"
  git bundle create --quiet "$FIX/rel/aprscaching-v1.1.0.bundle" refs/tags/v1.1.0
  # a bundle published under v1.1.0's name that holds another tag
  git bundle create --quiet "$FIX/rel-notag/aprscaching-v1.1.0.bundle" refs/tags/v1.0.0
  # the same tag name at another commit: what a tag pushed outside the release workflow looks like
  g checkout --quiet v1.0.0 && g commit --quiet --allow-empty -m other && g tag -f -a -m v1.1.0 v1.1.0 >/dev/null
  git bundle create --quiet "$FIX/rel-moved/aprscaching-v1.1.0.bundle" refs/tags/v1.1.0
) >/dev/null 2>&1
for d in rel rel-moved rel-notag; do (cd "$FIX/$d" && sha256sum aprscaching-v1.1.0.bundle >SHA256SUMS); done
RELEASE="$(git -C "$FIX/origin.git" rev-parse 'v1.1.0^{commit}')"
OTHER="$(git -C "$FIX/src" rev-parse 'v1.1.0^{commit}')"
N=0
# rc_case CALLER MODE [options]: run one case in $W; its output in $TMP/rc.out and $TMP/rc.err, its exit status in $RC
rc_case() {
  local c="$1" m="$2"
  shift 2
  N=$((N + 1))
  W="$TMP/case$N"
  mkdir -p "$W"
  RC=0
  bash "$DEPLOY/test/release-case.sh" "$c" "$m" "$W" "$FIX" "$@" >"$TMP/rc.out" 2>"$TMP/rc.err" </dev/null || RC=$?
}
stopped() { [ "$RC" != 0 ] && [ ! -e "$W/applied" ] && [ -z "$(ls -A "$W/tmp")" ] && ! grep -q useradd "$TMP/rc.out"; }
for caller in init update; do
  if [ "$caller" = init ]; then args=(--ref v1.1.0); else args=(); fi
  rc_case "$caller" good "${args[@]+"${args[@]}"}"
  check "$caller: a release whose checksum and signature verify goes ahead with --yes" eq "$RC:$([ -e "$W/applied" ] && echo applied)" 0:applied
  check "  … saying so" grep -q "the release v1.1.0 is verified" "$TMP/rc.out"
  check "  … and leaves no download behind" eq "$(ls -A "$W/tmp")" ""
  rc_case "$caller" tampered "${args[@]+"${args[@]}"}"
  check "$caller: a bundle that does not match its checksum stops before any change" stopped
  check "  … naming the checksum" grep -q "does not match its checksum" "$TMP/rc.err"
  rc_case "$caller" notag "${args[@]+"${args[@]}"}"
  check "$caller: a verified bundle that holds no tag v1.1.0 stops before any step" stopped
  check "  … naming the tag" grep -q "the release bundle holds no tag v1.1.0" "$TMP/rc.err"
  rc_case "$caller" unattested "${args[@]+"${args[@]}"}"
  check "$caller: a bundle with no attestation stops before any step" stopped
  check "  … as a refusal, quoting gh" bash -c "grep -q 'signed provenance does not verify' '$TMP/rc.err' && grep -q 'HTTP 404' '$TMP/rc.err'"
  rc_case "$caller" otherflow "${args[@]+"${args[@]}"}"
  check "$caller: an attestation by another workflow than the release workflow stops" stopped
  check "  … naming the release workflow" grep -q "no attestation by apachler/aprscaching/.github/workflows/release-verify.yml covers it" "$TMP/rc.err"
  rc_case "$caller" sigstore "${args[@]+"${args[@]}"}"
  check "$caller: a check that could not run stops" stopped
  check "  … saying it could not run, with gh's exit and message, not that it failed" bash -c "grep -q 'could not be checked: gh attestation verify exited 1' '$TMP/rc.err' && grep -q 'no valid Sigstore verifiers' '$TMP/rc.err' && ! grep -q 'does not verify' '$TMP/rc.err'"
  rc_case "$caller" error "${args[@]+"${args[@]}"}"
  check "$caller: a failed download stops, not taken for a missing bundle" stopped
  check "  … naming the server's answer" grep -q "HTTP 500" "$TMP/rc.err"
  rc_case "$caller" nogh "${args[@]+"${args[@]}"}"
  check "$caller: without gh the signature cannot be checked, so it stops" stopped
  check "  … pointing to --checksum-only" grep -q -- "--checksum-only" "$TMP/rc.err"
  rc_case "$caller" nogh --checksum-only "${args[@]+"${args[@]}"}"
  check "$caller: --checksum-only accepts the checksum alone" eq "$RC:$([ -e "$W/applied" ] && echo applied)" 0:applied
  check "  … with its warning" grep -q "only the checksum was checked" "$TMP/rc.err"
  rc_case "$caller" missing "${args[@]+"${args[@]}"}"
  check "$caller: a tag with no bundle is not passed by --yes alone" stopped
  check "  … says it is unverified" grep -q "v1.1.0 (tag) is not verified" "$TMP/rc.err"
  check "  … and how to take it anyway" grep -q -- "--unverified" "$TMP/rc.err"
  rc_case "$caller" missing --unverified "${args[@]+"${args[@]}"}"
  check "$caller: --unverified takes it, warned" eq "$RC:$([ -e "$W/applied" ] && echo applied)" 0:applied
  check "  … warned" grep -q "v1.1.0 (tag) is not verified" "$TMP/rc.err"
  rc_case "$caller" good --ref main
  check "$caller: a branch is not passed by --yes alone" stopped
  check "  … says it is unverified" grep -q "main (branch) is not verified" "$TMP/rc.err"
  rc_case "$caller" good --ref main --unverified
  check "$caller: --unverified takes a branch" eq "$RC:$([ -e "$W/applied" ] && echo applied)" 0:applied
done
# update at the target: a shape whose installation still needs its own version's layout (shape_update_pending)
# gets shape_update_apply; one that does not is left alone.
at_target() { # at_target PENDING(0|1) [APPLY_RC]: run_update in a checkout already at the newest tag; the marker in $TMP/at.applied
  rm -rf "$TMP/at" "$TMP/at.applied"
  git clone --quiet "$FIX/origin.git" "$TMP/at"
  git -C "$TMP/at" -c advice.detachedHead=false checkout --quiet v1.1.0
  bash -c "APRS_INTERACTIVE=0 APRS_ASSUME_YES=1; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/update.sh'; SHAPE=baremetal
    shape_git() { git -C '$TMP/at' \"\$@\"; }
    shape_update_apply() { touch '$TMP/at.applied'; return ${2:-0}; }
    shape_update_pending() { [ $1 = 1 ]; }
    shape_doctor_context() { DOC_BASE=''; }
    run_doctor() { :; }
    run_update" >"$TMP/at.out" 2>&1
}
at_target 1
check "update at the target applies a layout the installation still needs" bash -c "[ -e '$TMP/at.applied' ] && grep -q 'already at v1.1.0' '$TMP/at.out'"
at_target 0
check "  … and leaves an installation that needs none alone" bash -c "[ ! -e '$TMP/at.applied' ] && grep -q 'already at v1.1.0' '$TMP/at.out'"
at_target 1 1 || true
check "  … and says to run it again when that fails" grep -q "then run deploy/aprscaching update again: it finishes what is left" "$TMP/at.out"
check "bare metal's layout is pending while the service user owns anything outside data/" bash -c "
  . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DIR='$TMP/at'; BM_USER=\$(id -un)
  mkdir -p '$TMP/at/data'; bm_checkout_is_service_users"
# The build is owed until the commit it was built from is the checkout's: a build that failed left none.
pending_at() { # pending_at: shape_update_pending in $TMP/at, a root-owned checkout as far as the stand-ins tell
  mkdir -p "$TMP/at/deploy" "$TMP/at/units"
  : >"$TMP/at/deploy/.env"
  printf '[Service]\nUser=nobody\n' >"$TMP/at/units/aprscaching-gateway.service"
  bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/shapes/baremetal.sh'; SHAPE_ENV='$TMP/at/deploy/.env' BM_UNIT_DIR='$TMP/at/units'
    bm_owner() { echo root; }; bm_root() { \"\$@\"; }; bm_service_owned() { :; }; shape_update_pending"
}
rm -f "$TMP/at/.git/aprscaching-built"
check "bare metal's build is owed when no build finished" pending_at
git -C "$TMP/at" rev-parse HEAD >"$TMP/at/.git/aprscaching-built"
not_pending_at() { ! pending_at; }
check "  … and not once one finished at the checkout's commit" not_pending_at
git -C "$TMP/at" rev-parse HEAD~1 >"$TMP/at/.git/aprscaching-built"
check "  … and again when the last one finished at another commit" pending_at

rc_case update good
check "update: the checkout moves to the commit inside the verified bundle" eq "$(cat "$W/applied" 2>/dev/null)" "$RELEASE"
rc_case update moved
check "update: a tag on origin at another commit than the verified release's stops before any rebuild" stopped
check "  … naming both commits" grep -q "on origin is commit $RELEASE, but the verified release v1.1.0 is commit $OTHER" "$TMP/rc.err"
rc_case update good --ref v1.1.0
check "update: --ref to a release tag is verified like the newest" grep -q "the release v1.1.0 is verified" "$TMP/rc.out"
check "a GitHub repository URL gives owner/name" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/release.sh'; [ \"\$(rel_github_repo https://github.com/apachler/aprscaching.git)\" = apachler/aprscaching ] && [ \"\$(rel_github_repo git@github.com:apachler/aprscaching.git)\" = apachler/aprscaching ] && [ -z \"\$(rel_github_repo https://git.example.org/a/b)\" ]"

render() {
  bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/shapes/baremetal.sh';
    BM_DIR=/srv/acs BM_USER=acs BM_PORT=8090; bm_render_unit '$DEPLOY/systemd/aprscaching-gateway.service'"
}
U="$TMP/gateway.unit"
render >"$U"
check "a rendered unit uses the install directory" bash -c "grep -q '^WorkingDirectory=/srv/acs\$' '$U' && ! grep -q /opt/aprscaching '$U'"
check "  … the service user" bash -c "grep -q '^User=acs\$' '$U'"
check "  … the port" bash -c "grep -q '^Environment=PORT=8090\$' '$U'"
check "  … the web app" bash -c "grep -q '^Environment=WEB_DIST=/srv/acs/apps/web/dist\$' '$U'"
check "  … pnpm by absolute path" bash -c "grep -qE '^ExecStart=/[^ ]*(pnpm|corepack pnpm) --filter @aprscaching/node-gateway start\$' '$U'"
check "  … a read-only system with data/ the one writable place" bash -c "grep -qx 'ProtectSystem=strict' '$U' && grep -qx 'ReadWritePaths=/srv/acs/data' '$U'"
check "  … no new privileges, no capabilities, owner-only files" bash -c "grep -qx 'NoNewPrivileges=yes' '$U' && grep -qx 'CapabilityBoundingSet=' '$U' && grep -qx 'UMask=0077' '$U'"
check "  … no devices and no home directories" bash -c "grep -qx 'PrivateDevices=yes' '$U' && grep -qx 'ProtectHome=yes' '$U'"
I="$TMP/ingest.unit"
bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/shapes/baremetal.sh';
  BM_DIR=/srv/acs BM_USER=acs BM_PORT=8090; bm_render_unit '$DEPLOY/systemd/aprscaching-ingest.service'" >"$I"
check "the ingest unit: a read-only system, owner-only files" bash -c "grep -qx 'ProtectSystem=strict' '$I' && grep -qx 'NoNewPrivileges=yes' '$I' && grep -qx 'UMask=0077' '$I'"
check "  … with the radios' devices open" bash -c "! grep -qE '^(PrivateDevices|DevicePolicy|DeviceAllow|RestrictAddressFamilies)=' '$I'"
check "  … and data/ writable, for the MeshCom transmit audit (MESHCOM_TX_AUDIT)" bash -c "grep -qx 'ReadWritePaths=/srv/acs/data' '$I'"
# An install directory under /home: ProtectHome=yes would hide the gateway's own code, so /home is read-only there.
HOMEUNIT="$TMP/gateway-home.unit"
bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/shapes/baremetal.sh';
  BM_DIR=/home/op/aprscaching BM_USER=acs BM_PORT=8090; bm_render_unit '$DEPLOY/systemd/aprscaching-gateway.service'" >"$HOMEUNIT"
check "a gateway installed under /home sees its checkout read-only" bash -c "grep -qx 'ProtectHome=read-only' '$HOMEUNIT' && ! grep -qx 'ProtectHome=yes' '$HOMEUNIT' && grep -qx 'ReadWritePaths=/home/op/aprscaching/data' '$HOMEUNIT'"

# Bare metal behind a reverse proxy: the gateway listens on 127.0.0.1 and trusts the proxy's X-Forwarded-For entry.
proxy_bind() { # proxy_bind FILE: bm_proxy_bind with the user running this test standing in for root
  bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; DEPLOY_DIR='$DEPLOY'
    . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DIR='$(dirname "$DEPLOY")'; bm_root() { \"\$@\"; }; bm_proxy_bind '$1'"
}
printf '%s\n' "APP_URL=https://aprs.example.net" "# HOST=127.0.0.1" >"$TMP/bm-proxy.env"
check "bare metal writes the proxy settings behind an https APP_URL" proxy_bind "$TMP/bm-proxy.env"
check "bare metal behind a proxy listens on 127.0.0.1" eq "$(env_file_get "$TMP/bm-proxy.env" HOST)" 127.0.0.1
check "  … and trusts one proxy's X-Forwarded-For entry" eq "$(env_file_get "$TMP/bm-proxy.env" TRUST_PROXY)" 1
check "  … the .env stays owner-only" eq "$(stat -c %a "$TMP/bm-proxy.env")" 600
printf '%s\n' "APP_URL=https://aprs.example.net" "HOST=0.0.0.0" "TRUST_PROXY=2" >"$TMP/bm-proxy.env"
check "  … runs over an operator's own values" proxy_bind "$TMP/bm-proxy.env"
check "  … a HOST and TRUST_PROXY the operator set stay" eq "$(env_file_get "$TMP/bm-proxy.env" HOST) $(env_file_get "$TMP/bm-proxy.env" TRUST_PROXY)" "0.0.0.0 2"
printf '%s\n' "APP_URL=http://192.168.1.10:8080" >"$TMP/bm-proxy.env"
check "bare metal on plain http runs the proxy step" proxy_bind "$TMP/bm-proxy.env"
check "bare metal on plain http is the gateway itself, on every interface" bash -c "! grep -qE '^(HOST|TRUST_PROXY)=' '$TMP/bm-proxy.env'"
# The .env is root's alone. A stand-in bm_root plays root: it alone may read the file, so an installer that
# reads it itself sees nothing and writes nothing.
proxy_bind_as_root() { # proxy_bind_as_root FILE
  bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; DEPLOY_DIR='$DEPLOY'
    . '$DEPLOY/lib/shapes/baremetal.sh'; BM_DIR='$(dirname "$DEPLOY")'
    bm_root() { chmod 600 '$1'; \"\$@\"; local rc=\$?; chmod 000 '$1'; return \$rc; }
    bm_proxy_bind '$1'"
}
printf '%s\n' "APP_URL=https://aprs.example.net" >"$TMP/bm-proxy.env"
chmod 000 "$TMP/bm-proxy.env"
check "bare metal reads the .env as root when the installer cannot" proxy_bind_as_root "$TMP/bm-proxy.env"
chmod 600 "$TMP/bm-proxy.env"
check "  … and sets HOST and TRUST_PROXY there" eq "$(env_file_get "$TMP/bm-proxy.env" HOST) $(env_file_get "$TMP/bm-proxy.env" TRUST_PROXY)" "127.0.0.1 1"
if [ "$(id -u)" != 0 ]; then # root reads a mode-000 file
  chmod 000 "$TMP/bm-proxy.env"
  refused() { ! proxy_bind "$1" 2>/dev/null; }
  check "a .env root cannot read fails, never passes for an unset APP_URL" refused "$TMP/bm-proxy.env"
  chmod 600 "$TMP/bm-proxy.env"
fi

# ---- doctor ------------------------------------------------------------------------------------------------
# A stub gateway (fixtures/stub-gateway.py) answers on a free port; doctor checks it through the Pocket
# context, whose settings live in one .env.
if have python3; then
  PORT_STUB="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  ING="ingest-0123456789abcdef0123456789" OPS="operator-0123456789abcdef01234567"
  STUB_INGEST="$ING" STUB_OPERATOR="$OPS" STUB_SCHEMA=0000_older.sql \
    python3 "$HERE/fixtures/stub-gateway.py" "$PORT_STUB" &
  STUB_PID=$!
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT_STUB/health" >/dev/null 2>&1 && break; sleep 0.1; done
  PD="$TMP/pocket"
  mkdir -p "$PD" "$TMP/backups"
  printf 'PORT=%s\nAPP_URL=http://127.0.0.1:%s\nINGEST_SECRET=%s\nOPERATOR_SECRET=%s\nINGEST_URL=http://127.0.0.1:%s/ingest\nAPRSIS_HOST=127.0.0.1\nAPRSIS_PORT=1\nFED_AUTOPROMOTE=0\n' \
    "$PORT_STUB" "$PORT_STUB" "$ING" "$OPS" "$PORT_STUB" >"$PD/.env"
  chmod 644 "$PD/.env"
  touch "$TMP/backups/aprscaching-pocket-20260101T000000Z.tar.gz"
  doctor() { APRSCACHING_DATA="$PD" APRSCACHING_BACKUP_DIR="$TMP/backups" "$H" --shape pocket "$@" doctor </dev/null >"$TMP/out" 2>"$TMP/err"; }
  status_of() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=j.checks.find(c=>c.id===process.argv[2]);console.log(c?c.status:"absent")' "$TMP/out" "$1"; }
  if have node; then
    if doctor --json; then bad "doctor fails when a check fails"; else ok "doctor fails when a check fails"; fi
    check "  … its JSON parses" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP/out"
    check "  … a world-readable .env fails" eq "$(status_of config.permissions)" fail
    check "  … a misspelt key is pointed out" eq "$(status_of config.unknown)" warn
    check "  … the gateway answers" eq "$(status_of gateway.reachable)" pass
    check "  … an older schema than the checkout is reported" eq "$(status_of gateway.migrations)" warn
    check "  … the ingest credential is accepted" eq "$(status_of ingest.credentials)" pass
    check "  … the Setup checklist is relayed, labelled" grep -q '"Imprint: incomplete"' "$TMP/out"
    check "  … a blocking checklist item fails" eq "$(status_of setup.db:ingest)" fail
    check "  … a newer release warns, never fails" eq "$(status_of setup.update)" warn
    check "  … naming the release and the update command" grep -q 'APRScaching v1.1.0 is available: https://example.org/acs/releases/tag/v1.1.0.*deploy/aprscaching update' "$TMP/out"
    check "  … the instance settings changed in Instance admin are listed" eq "$(status_of site.settings)" pass
    check "  … with their values, and the ones the environment overrides" grep -q 'HIDE_DAILY_LIMIT=3; overridden by the environment: UPDATE_CHECK' "$TMP/out"
    check "  … a LAN instance has federation off" eq "$(status_of federation.off)" pass
    check "  … a recent backup passes" eq "$(status_of resources.backup)" pass
    check "  … the source link passes" eq "$(status_of source.link)" pass
    check "  … no secret appears in the report" bash -c "! grep -qE '$ING|$OPS' '$TMP/out' '$TMP/err'"
    check "  … no mail transport is no failure" eq "$(status_of mail.transport)" pass
    chmod 600 "$PD/.env"
    printf 'EMAIL_FROM=noreply@example.net\nSMTP_HOST=127.0.0.1\nSMTP_PORT=%s\nSMTP_PASS=mailbox-0123456789\n' "$PORT_STUB" >>"$PD/.env"
    doctor --json || true
    check "SMTP is named as the mail transport" grep -q "over SMTP 127.0.0.1:$PORT_STUB (starttls)" "$TMP/out"
    check "  … and a server that answers passes" eq "$(status_of mail.smtp)" pass
    check "  … without showing its password" bash -c "! grep -q mailbox-0123456789 '$TMP/out' '$TMP/err'"
    env_file_set "$PD/.env" SMTP_PORT 1
    doctor --json || true
    check "an SMTP server that does not answer warns" eq "$(status_of mail.smtp)" warn
    env_file_unset "$PD/.env" SMTP_HOST
    env_file_set "$PD/.env" INGEST_SECRET "wrong-0123456789abcdef0123456789"
    doctor --json || true
    check "a wrong ingest secret fails" eq "$(status_of ingest.credentials)" fail
    check "  … and the permissions now pass" eq "$(status_of config.permissions)" pass
    env_file_set "$PD/.env" OPERATOR_SECRET "x-0123456789abcdef0123456789abcd"
    doctor --json || true
    check "a wrong operator secret leaves the checklist unread" eq "$(status_of setup.checklist)" warn
    touch -d '30 days ago' "$TMP/backups/aprscaching-pocket-20260101T000000Z.tar.gz"
    doctor --json || true
    check "an old backup warns" eq "$(status_of resources.backup)" warn
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
    doctor --json || true
    check "a gateway that does not answer fails" eq "$(status_of gateway.reachable)" fail
    STUB_SPA=1 STUB_INGEST="$ING" STUB_OPERATOR="$OPS" python3 "$HERE/fixtures/stub-gateway.py" "$PORT_STUB" &
    STUB_PID=$!
    for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT_STUB/" >/dev/null 2>&1 && break; sleep 0.1; done
    env_file_set "$PD/.env" INGEST_SECRET "$ING"
    doctor --json || true
    check "a proxy serving the web app for /health is not the gateway" eq "$(status_of gateway.reachable)" fail
    check "  … nor for /ingest/check" eq "$(status_of ingest.credentials)" fail
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
    doctor || true
    check "the text report counts the results" grep -qE '[0-9]+ passed, [0-9]+ warnings, [0-9]+ failed' "$TMP/out"
  else
    kill "$STUB_PID" 2>/dev/null || true
    echo "skip doctor (needs Node.js to read its JSON)"
  fi
else
  echo "skip doctor (needs python3 for the stub gateway)"
fi
# ---- init ingest-box ---------------------------------------------------------------------------------------
if have python3 && have docker; then
  PORT_IB="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  STUB_INGEST="gw-shared-0123456789abcdef0123" STUB_OPERATOR="x" python3 "$HERE/fixtures/stub-gateway.py" "$PORT_IB" &
  IB_PID=$!
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT_IB/health" >/dev/null 2>&1 && break; sleep 0.1; done
  IB="$TMP/ib.env"
  printf 'shape=ingest-box\nenv=%s\n' "$IB" >"$APRSCACHING_SHAPE_FILE"
  printf 'OPERATOR_SECRET=x\n' >"$IB"
  check "init ingest-box refuses a gateway's settings" bash -c "'$H' --non-interactive init ingest-box --gateway http://127.0.0.1:$PORT_IB 2>&1 </dev/null | grep -q 'belongs to a gateway'"
  if "$H" --non-interactive init ingest-box --gateway http://127.0.0.1:$PORT_IB </dev/null >/dev/null 2>&1; then
    bad "  … and stops"
  else
    ok "  … and stops"
  fi
  : >"$IB"
  if "$H" --non-interactive init ingest-box --gateway http://127.0.0.1:1 --shared-secret --call OE8APR --no-start </dev/null >"$TMP/out" 2>"$TMP/err"; then
    bad "init ingest-box stops when the gateway does not answer"
  else
    ok "init ingest-box stops when the gateway does not answer"
  fi
  check "init ingest-box sets up a box on the shared secret" env INGEST_SECRET="gw-shared-0123456789abcdef0123" \
    "$H" --non-interactive init ingest-box --gateway "http://127.0.0.1:$PORT_IB/" --shared-secret --call oe8apr \
    --kiss 192.168.1.20:8001 --site-call oe8apr-10 --no-start
  check "  … pointing at the gateway's /ingest" eq "$(env_file_get "$IB" INGEST_URL)" "http://127.0.0.1:$PORT_IB/ingest"
  check "  … with the secret, owner-only" bash -c "[ \"\$(. '$DEPLOY/lib/env.sh'; env_file_get '$IB' INGEST_SECRET)\" = gw-shared-0123456789abcdef0123 ] && [ \"\$(. '$DEPLOY/lib/env.sh'; file_mode '$IB')\" = 600 ]"
  check "  … the call upper-cased" eq "$(env_file_get "$IB" APRSIS_CALLSIGN)" "OE8APR"
  check "  … the TNC split into host and port" eq "$(env_file_get "$IB" KISS_TNC_HOST):$(env_file_get "$IB" KISS_TNC_PORT)" "192.168.1.20:8001"
  check "  … its receiving site named" eq "$(env_file_get "$IB" RF_SITE_CALL)" "OE8APR-10"
  check "  … and the shape recorded" grep -qx "shape=ingest-box" "$APRSCACHING_SHAPE_FILE"
  kill "$IB_PID" 2>/dev/null || true
  wait "$IB_PID" 2>/dev/null || true
  rm -f "$APRSCACHING_SHAPE_FILE"
else
  echo "skip init ingest-box (needs python3 and docker)"
fi
if "$H" --non-interactive init cloudflare </dev/null >"$TMP/out" 2>"$TMP/err"; then
  bad "init refuses a shape it does not know"
else
  ok "init refuses a shape it does not know"
fi
check "  … and recorded nothing" test ! -e "$APRSCACHING_SHAPE_FILE"
check "init ingest-box --help lists its options" bash -c "'$H' init ingest-box --help | grep -q -- '--code CODE'"

# ---- backup archives (the parts that need no database) -----------------------------------------------------
NEWEST="$(find "$DEPLOY/../db/migrations" -name '*.sql' -exec basename {} \; | sort | tail -n 1)"
mkarchive() { # mkarchive FILE SCHEMA: a minimal archive with a manifest, rows and settings
  local d="$TMP/arch"
  rm -rf "$d" && mkdir -p "$d/secrets"
  printf '{\n  "format": "aprscaching-backup/1",\n  "createdAt": 1790000000,\n  "shape": "selfhost",\n  "schema": "%s",\n  "sensitive": true\n}\n' "$2" >"$d/manifest.json"
  printf -- '-- aprscaching rows/1 schema=%s\nINSERT INTO "caches" ("id") VALUES(1);\nINSERT INTO "caches" ("id") VALUES(2);\nINSERT INTO "watches" ("callsign") VALUES(\x27A\x27);\n' "$2" >"$d/rows.sql"
  printf 'APP_URL=https://aprs.example.net\nDB_PATH=/elsewhere/x.db\nADMIN_CALLSIGNS=OE8APR\n' >"$d/settings.env"
  tar -czf "$1" -C "$d" .
}
mkarchive "$TMP/a.tar.gz" "$NEWEST"
tar -xzf "$TMP/a.tar.gz" -C "$TMP" ./rows.sql
check "rows are counted per table" eq "$(bash -c ". '$DEPLOY/lib/common.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/backup.sh'; rows_counts_json '$TMP/rows.sql'")" '{"caches":2,"watches":1}'
PDATA="$TMP/pk"
mkdir -p "$PDATA"
printf 'APP_URL=http://192.168.43.1:8787\nDB_PATH=%s/aprscaching.db\n' "$PDATA" >"$PDATA/.env"
restore_dry() { APRSCACHING_DATA="$PDATA" "$H" --shape pocket restore "$@" </dev/null >"$TMP/out" 2>"$TMP/err"; }
check "a dry run describes the restore" restore_dry "$TMP/a.tar.gz" --dry-run
check "  … names the instance settings it would restore, not the host's" bash -c "grep -q 'settings restored: APP_URL ADMIN_CALLSIGNS\$' '$TMP/out'"
check "  … and changes nothing" eq "$(env_file_get "$PDATA/.env" APP_URL)" "http://192.168.43.1:8787"
check "  … says the move between shapes keeps APP_URL" grep -q "keep the same APP_URL" "$TMP/out"
mkarchive "$TMP/future.tar.gz" "9999_from_the_future.sql"
if restore_dry "$TMP/future.tar.gz" --dry-run; then bad "a backup newer than the checkout is refused"; else ok "a backup newer than the checkout is refused"; fi
check "  … with the way out" grep -q "Update this installation first" "$TMP/err"
printf 'not an archive' >"$TMP/junk.tar.gz"
if restore_dry "$TMP/junk.tar.gz" --dry-run; then bad "a file that is not an archive is refused"; else ok "a file that is not an archive is refused"; fi
mkarchive "$TMP/escape.tar.gz" "../x"
# the refusal is its own message: a schema that reaches outside db/migrations is not "newer than this checkout"
restore_dry "$TMP/escape.tar.gz" --dry-run || true
check "a manifest whose schema is no migration file name is refused, naming it" \
  grep -q "schema '../x', which is no migration file name" "$TMP/err"
check "  … before it describes the restore" bash -c "! grep -q 'Restore of a' '$TMP/out'"
restore_dry "$TMP/a.tar.gz" --dry-run || true
check "a restore shows the archive's time" grep -q "^    archive: a.tar.gz, written " "$TMP/out"
check "  … and its manifest" grep -q '"createdAt": 1790000000' "$TMP/out"

# ---- restored settings: only known keys, each written so that a shell sourcing the .env runs nothing ----------
SRC="$TMP/settings-src.env"
printf '%s\n' 'APP_URL=$(touch '"$TMP"'/ran-unquoted)' 'ADMIN_CALLSIGNS="`touch '"$TMP"'/ran-backtick`"' \
  "OPERATOR_NAME='Station \$(touch $TMP/ran-single)'" 'RP_ID=aprs.example.net' 'RETENTION={"positions": 30}' 'NOT_A_SETTING=1' \
  'DB_PATH=/elsewhere/x.db' >"$SRC"
DST="$TMP/settings-dst.env"
printf 'APP_URL=https://kept.example\nDB_PATH=/here/x.db\n' >"$DST"
check "restored settings are written" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/config.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/backup.sh'; bk_settings_write '$SRC' '$DST'"
check "  … a value holding \$(…) is left out, the current one kept" eq "$(env_file_get "$DST" APP_URL)" "https://kept.example"
check "  … a double-quoted value holding a backtick is left out" bash -c "! grep -q '^ADMIN_CALLSIGNS=' '$DST'"
check "  … a single-quoted value comes back single-quoted, as written" eq "$(grep '^OPERATOR_NAME=' "$DST")" "OPERATOR_NAME='Station \$(touch $TMP/ran-single)'"
check "  … a plain value plainly" eq "$(grep '^RP_ID=' "$DST")" "RP_ID=aprs.example.net"
check "  … a JSON value single-quoted, read back as written" eq "$(env_file_get "$DST" RETENTION)" '{"positions": 30}'
check "  … an unknown key and this host's own are not written" bash -c "! grep -q '^NOT_A_SETTING=' '$DST' && grep -qx 'DB_PATH=/here/x.db' '$DST'"
check "  … and sourcing the .env runs none of them" bash -c "set -a; . '$DST'; set +a; [ ! -e '$TMP/ran-unquoted' ] && [ ! -e '$TMP/ran-backtick' ] && [ ! -e '$TMP/ran-single' ]"

# ---- Pocket: an archive on shared storage brings no settings or secret files into the station --------------
SH="$TMP/pkshared"
mkdir -p "$SH/home/storage/shared" "$SH/data" "$SH/arch"
tar -xzf "$TMP/a.tar.gz" -C "$SH/arch"
printf 'SESSION_SECRET=planted-session-secret-0123456789\nAPP_URL=https://planted.example\n' >"$SH/arch/settings.env"
printf 'planted\n' >"$SH/arch/secrets/session.secret"
tar -czf "$SH/home/storage/shared/aprscaching-selfhost-20261001T020000Z.tar.gz" -C "$SH/arch" .
cp "$SH/home/storage/shared/aprscaching-selfhost-20261001T020000Z.tar.gz" "$SH/data/"
pk_restore() { # pk_restore ARCHIVE: the real restore on the Pocket shape, its database, stop and start hooks stubbed
  printf 'mine\n' >"$SH/data/session.secret"
  printf 'APP_URL=https://mine.example\n' >"$SH/data/.env"
  HOME="$SH/home" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/config.sh'
    DEPLOY_DIR='$DEPLOY'; APRS_JSON=0 APRS_INTERACTIVE=0 APRS_ASSUME_YES=1; SHAPE=pocket SHAPE_ENV='$SH/data/.env'
    . '$DEPLOY/lib/backup.sh'; . '$DEPLOY/lib/shapes/pocket.sh'
    shape_db_restore() { :; }; shape_stop() { :; }; shape_start() { :; }; run_doctor() { :; }; sleep() { :; }
    run_restore '$1'" >"$TMP/out" 2>"$TMP/err"
}
check "Pocket: an archive on shared storage restores" pk_restore "$SH/home/storage/shared/aprscaching-selfhost-20261001T020000Z.tar.gz"
check "  … but not its secret files" eq "$(cat "$SH/data/session.secret")" mine
check "  … nor its settings" bash -c "grep -qx 'APP_URL=https://mine.example' '$SH/data/.env' && ! grep -q SESSION_SECRET '$SH/data/.env'"
check "  … and says so" grep -q "its settings and secret files are not restored" "$TMP/err"
check "  … from Termux's own storage they are" pk_restore "$SH/data/aprscaching-selfhost-20261001T020000Z.tar.gz"
check "  … the secret files" eq "$(cat "$SH/data/session.secret")" planted
check "  … and the settings" grep -qx "APP_URL=https://planted.example" "$SH/data/.env"
if APRSCACHING_DATA="$PDATA" "$H" --non-interactive --shape pocket restore "$TMP/a.tar.gz" </dev/null >/dev/null 2>&1; then
  bad "a restore without --yes changes nothing when nobody can be asked"
else
  ok "a restore without --yes changes nothing when nobody can be asked"
fi
check "  … the settings are untouched" eq "$(env_file_get "$PDATA/.env" APP_URL)" "http://192.168.43.1:8787"

# ---- deploy/backup.sh: the nightly snapshot is its owner's alone, whatever umask cron runs it with ----------
mkdir -p "$TMP/sqlbin"
cat >"$TMP/sqlbin/sqlite3" <<'MOCK'
#!/bin/sh
# stand-in for: sqlite3 DB ".backup 'DST'"
dst="${2#.backup \'}"
cp "$1" "${dst%\'}"
MOCK
chmod +x "$TMP/sqlbin/sqlite3"
printf 'a database\n' >"$TMP/nightly.db"
(umask 022 && PATH="$TMP/sqlbin:$PATH" DB_PATH="$TMP/nightly.db" BACKUP_DIR="$TMP/nightly" bash "$DEPLOY/backup.sh" >/dev/null)
SNAP="$(find "$TMP/nightly" -name '*.db.gz' 2>/dev/null | head -n 1)"
check "deploy/backup.sh writes a snapshot to BACKUP_DIR" test -n "$SNAP"
check "  … readable by its owner only" eq "$(file_mode "${SNAP:-$TMP/none}" 2>/dev/null)" 600
check "  … in a directory of its owner's" eq "$(file_mode "$TMP/nightly" 2>/dev/null)" 700

# ---- OCI bucket: upload, restore from it, and its age in doctor (the oci CLI mocked) --------------------------
mkdir -p "$TMP/ocibin"
cat >"$TMP/ocibin/oci" <<'MOCK'
#!/usr/bin/env bash
echo "oci $*" >>"$OCI_LOG"
case "$*" in
  *"object head"*) printf '{\n  "content-length": "1",\n  "last-modified": "Thu, 01 Oct 2026 02:00:05 GMT"\n}\n' ;;
  *"object list"*)
    case "$*" in *'."time-created"'*) echo "${OCI_NEWEST_TIME:-null}" ;; *) echo "${OCI_NEWEST:-null}" ;; esac ;;
  *"object get"*) while [ $# -gt 0 ]; do [ "$1" = --file ] && cp "$OCI_ARCHIVE" "$2"; shift; done ;;
  *"object put"*) ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$TMP/ocibin/oci"
export OCI_LOG="$TMP/oci.log" OCI_ARCHIVE="$TMP/a.tar.gz"
: >"$OCI_LOG"
oci_restore_dry() { PATH="$TMP/ocibin:$PATH" OCI_NEWEST="archives/aprscaching-selfhost-20261001T020000Z.tar.gz" restore_dry "$@"; }
check "restore takes the archive named in a bucket" oci_restore_dry oci://acs-backups/archives/aprscaching-selfhost-20261001T020000Z.tar.gz --dry-run
check "  … downloads that one" grep -q "object get -bn acs-backups --name archives/aprscaching-selfhost-20261001T020000Z.tar.gz" "$OCI_LOG"
check "  … shows when it was uploaded" grep -q "archive: aprscaching-selfhost-20261001T020000Z.tar.gz, uploaded Thu, 01 Oct 2026 02:00:05 GMT" "$TMP/out"
check "  … and its manifest" grep -q '"createdAt": 1790000000' "$TMP/out"
check "  … and describes it" grep -q "settings restored: APP_URL ADMIN_CALLSIGNS" "$TMP/out"
: >"$OCI_LOG"
if oci_restore_dry oci://b/latest --dry-run; then bad "restore oci://b/latest is refused"; else ok "restore oci://b/latest is refused"; fi
check "  … naming the form to use" grep -q "Name it as oci://<bucket>/archives/aprscaching-<shape>-<UTC time>.tar.gz" "$TMP/err"
check "  … before it asks the bucket anything" test ! -s "$OCI_LOG"
if oci_restore_dry oci://acs-backups --dry-run; then bad "a bucket address without an object is refused"; else ok "a bucket address without an object is refused"; fi
bk() { # bk ENVFILE FUNCTION ARGS…: one function of backup.sh, with the mocked oci on PATH
  local env="$1"
  shift
  PATH="$TMP/ocibin:$PATH" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; DEPLOY_DIR='$DEPLOY'; SHAPE_ENV='$env'
    . '$DEPLOY/lib/backup.sh'; . '$DEPLOY/lib/doctor.sh'; DOCS_URL=x
    SHAPE=\"\${SHAPE:-}\"; pass() { echo \"pass \$2\"; }; warnc() { echo \"warn \$2\"; }; failc() { echo \"fail \$2\"; }; \"\$@\"" _ "$@"
}
printf 'OCI_BUCKET=acs-backups\n' >"$TMP/bucket.env"
: >"$OCI_LOG"
check "an archive goes to OCI_BUCKET under archives/" bk "$TMP/bucket.env" bk_upload "$TMP/a.tar.gz"
check "  … by its own name" grep -q "object put -bn acs-backups --file $TMP/a.tar.gz --name archives/a.tar.gz --force" "$OCI_LOG"
: >"$OCI_LOG"
mkdir -p "$TMP/arch-local"
for d in 01 02 03 04 05; do cp "$TMP/a.tar.gz" "$TMP/arch-local/aprscaching-selfhost-202610${d}T020000Z.tar.gz"; done
cp "$TMP/a.tar.gz" "$TMP/arch-local/aprscaching-pocket-20261001T020000Z.tar.gz"
check "an upload leaves the local archives to the retention" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' SHAPE=selfhost bk '$TMP/bucket.env' bk_upload '$TMP/arch-local/aprscaching-selfhost-20261005T020000Z.tar.gz' >/dev/null"
check "  … which keeps them all" eq "$(find "$TMP/arch-local" -name 'aprscaching-selfhost-*' | wc -l | tr -d ' ')" 5
printf 'BACKUP_KEEP=3\n' >"$TMP/keep.env"
check "the local destination keeps the newest BACKUP_KEEP archives, uploaded or not" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' SHAPE=selfhost bk '$TMP/keep.env' eval 'bk_keep; bk_prune \"$TMP/arch-local\"' >/dev/null"
check "  … drops the older ones, and leaves another shape's alone" eq "$(cd "$TMP/arch-local" && ls | tr '\n' ' ')" \
  "aprscaching-pocket-20261001T020000Z.tar.gz aprscaching-selfhost-20261003T020000Z.tar.gz aprscaching-selfhost-20261004T020000Z.tar.gz aprscaching-selfhost-20261005T020000Z.tar.gz "
check "  … 14 when BACKUP_KEEP is unset" bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/a.env' eval 'bk_keep; echo \$BK_KEEP' | grep -qx 14"
printf 'BACKUP_KEEP=0\n' >"$TMP/keep0.env"
check "  … and BACKUP_KEEP=0 is refused" bash -c "$(declare -f bk); TMP='$TMP'; DEPLOY='$DEPLOY'; ! bk '$TMP/keep0.env' bk_keep 2>/dev/null"
printf 'BACKUP_BUCKET=b\n' >"$TMP/s3only.env"
check "a BACKUP_BUCKET without R2_ENDPOINT keeps backups on this host, and doctor says so" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/s3only.env' eval 'DOC_ENV=\$SHAPE_ENV; doc_backup_destination' | grep -q '^warn BACKUP_BUCKET is set without R2_ENDPOINT, so nothing is uploaded: backups stay on this host'"
printf 'OCI_BUCKET=b\n' >"$TMP/ocinocli.env"
check "an OCI_BUCKET without the oci CLI is no upload either" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/ocinocli.env' eval 'have() { [ \"\$1\" != oci ]; }; DOC_ENV=\$SHAPE_ENV; doc_backup_destination' | grep -q '^warn OCI_BUCKET is set, but the oci CLI .*: backups stay on this host'"
: >"$OCI_LOG"
check "without OCI_BUCKET nothing is uploaded" bk "$TMP/a.env" bk_upload "$TMP/a.tar.gz"
check "  … not even tried" test ! -s "$OCI_LOG"
check "doctor reads the newest bucket backup's age" bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' OCI_NEWEST_TIME='$(date -u +%Y-%m-%dT%H:%M:%S+00:00)' bk '$TMP/bucket.env' doc_bucket_backup_age acs-backups | grep -q '^pass the newest backup in the bucket acs-backups is 0 days old'"
check "  … warns when it is ten days old" bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' OCI_NEWEST_TIME='$(date -u -d '10 days ago' +%Y-%m-%dT%H:%M:%S+00:00)' bk '$TMP/bucket.env' doc_bucket_backup_age acs-backups | grep -q '^warn .* 10 days old'"
# where each backup tool writes: deploy/backup.sh's <time>.db.gz snapshots and the helper's archives
mkdir -p "$TMP/snaps" "$TMP/nosnaps" "$TMP/place-a" "$TMP/place-b"
touch "$TMP/snaps/20261001T020000Z.db.gz"
printf 'BACKUP_DIR=%s\n' "$TMP/snaps" >"$TMP/snaps.env"
printf 'BACKUP_DIR=%s\n' "$TMP/nosnaps" >"$TMP/nosnaps.env"
check "doctor finds deploy/backup.sh's snapshots in BACKUP_DIR" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/snaps.env' eval 'DOC_ENV=\$SHAPE_ENV; DOC_BACKUP_SETTINGS=1; doc_resources' | grep -q '^pass the newest backup is 0 days old'"
check "  … and fails on an empty BACKUP_DIR" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/nosnaps.env' eval 'DOC_ENV=\$SHAPE_ENV; DOC_BACKUP_SETTINGS=1; doc_resources' | grep -q '^fail no backup in'"
touch "$TMP/place-b/aprscaching-pocket-20261001T020000Z.tar.gz"
check "doctor takes the newest backup across a shape's places" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/a.env' eval 'DOC_BACKUP_PLACES=(\"$TMP/place-a|aprscaching-pocket-*.tar.gz\" \"$TMP/place-b|aprscaching-pocket-*.tar.gz\"); doc_resources' | grep -q '^pass the newest backup is 0 days old (aprscaching-pocket-'"
check "  … and only warns where a missing backup is a warning (Desktop)" \
  bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/a.env' eval 'DOC_BACKUP_PLACES=(\"$TMP/place-a|aprscaching-desktop-*.tar.gz\"); DOC_BACKUP_MISSING=warn; doc_resources' | grep -q '^warn no backup in'"
check "  … fails when the bucket has none" bash -c "$(declare -f bk); TMP='$TMP' DEPLOY='$DEPLOY' bk '$TMP/bucket.env' doc_bucket_backup_age acs-backups | grep -q '^fail no backup archive in the bucket'"

check "MeshCom firmware 4.35u is new enough" bash -c ". '$DEPLOY/lib/doctor.sh'; fw_at_least 4.35u 4 35 u"
check "  … 4.40a too" bash -c ". '$DEPLOY/lib/doctor.sh'; fw_at_least v4.40a 4 35 u"
check "  … 4.35t is not" bash -c ". '$DEPLOY/lib/doctor.sh'; ! fw_at_least 4.35t 4 35 u"
check "  … 4.34z is not" bash -c ". '$DEPLOY/lib/doctor.sh'; ! fw_at_least 4.34z 4 35 u"
# The soundcard checks the ingest prints (check.ts --soundcard) become doctor rows under their ids and links.
SC_ROWS="$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'
  doc_get() { [ \"\$1\" = SOUNDCARD_DEVICE ] && echo plughw:1,0; true; }
  shape_doctor_ingest_node() { printf 'alsa\t-\tpass\tarecord and aplay are installed\t\nptt\t1\tfail\tno hidraw\tudev\ntx\t1\twarn\tnot verified\tverify\n'; }
  doc_soundcard; printf '%s\n' \"\${DOC_ROWS[@]}\" | cut -f1,2,5")"
check "doctor relays the soundcard checks under their ids, each linked to its entry" eq "$SC_ROWS" \
  "$(printf 'pass\tingest.soundcard_alsa\t\nfail\tingest.soundcard_ptt.1\tdocs/run/troubleshooting.md#ingestsoundcard_pttport\nwarn\tingest.soundcard_tx.1\tdocs/run/troubleshooting.md#ingestsoundcard_txport')"
kisssock() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; doc_kiss_socket '$1'; printf '%s' \"\${DOC_ROWS[*]}\" | cut -f1,2"; }
KSOCK="$TMP/kiss.sock"
python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$KSOCK"
check "doctor passes a KISS_TNC_HOST path where a socket is" eq "$(kisssock "$KSOCK")" "$(printf 'pass\tingest.kiss_tnc')"
check "  … and fails a path with no socket" eq "$(kisssock "$TMP/none.sock")" "$(printf 'fail\tingest.kiss_tnc')"
: >"$TMP/plain.file"
check "  … or a file that is not one" eq "$(kisssock "$TMP/plain.file")" "$(printf 'fail\tingest.kiss_tnc')"
grace() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; tx_gate_grace_min '$1'"; }
check "TX_GATE_GRACE reads minutes and hours, as the ingest does" eq \
  "$(grace ''),$(grace 30),$(grace 45m),$(grace 2H),$(grace 1),$(grace 48h)" "6,30,45,120,6,1440"
check "  … and refuses anything else" bash -c ". '$DEPLOY/lib/doctor.sh'; ! tx_gate_grace_min soon && ! tx_gate_grace_min 2d"
gracerow() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh';
  doc_get() { case \"\$1\" in KISS_TNC_HOST) echo tnc ;; TX_GATE_GRACE) echo '$1' ;; esac; true; }
  doc_tx_gate_grace; printf '%s' \"\${DOC_ROWS[*]}\" | cut -f1,3"; }
check "doctor shows the grace in effect" eq "$(gracerow 30m)" \
  "$(printf 'pass\tthe TX gate keeps a confirmed call for 30 min while the gateway is unreachable')"
check "  … and warns above an hour" eq "$(gracerow 2h)" \
  "$(printf 'warn\ta revoked call keeps transmitting up to 120 min while the gateway is unreachable (TX_GATE_GRACE)')"
urlhttp() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; doc_ingest_url_http '$1'; printf '%s' \"\${DOC_ROWS[*]}\" | cut -f1,2"; }
check "doctor warns on a plain-http INGEST_URL beyond the LAN" eq "$(urlhttp http://gw.example.net/ingest)" \
  "$(printf 'warn\tingest.url_http')"
check "  … and on a 44Net address" eq "$(urlhttp http://44.143.1.2:8080/ingest)" "$(printf 'warn\tingest.url_http')"
check "  … not on https, loopback, a LAN address or the Docker service name" eq \
  "$(for u in https://gw.example.net/ingest http://127.0.0.1:8787/ingest 'http://[::1]:8787/ingest' \
    http://192.168.1.5:8787/ingest http://172.20.0.3/ingest http://gateway:8080/ingest http://pi.local/ingest; do
    urlhttp "$u"; done)" ""
check "  … and without a soundcard port it adds none" eq \
  "$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; doc_get() { true; }; doc_soundcard; echo \"\${#DOC_ROWS[@]}\"")" 0
# the same key and value as workers/gateway/test/fed_fingerprint.test.ts: doctor and Instance admin agree
FP_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
check "a federation key's fingerprint matches Instance admin's" eq \
  "$(bash -c ". '$DEPLOY/lib/doctor.sh'; fed_fingerprint $FP_KEY")" "630d cd29 66c4 3366"
check "  … read from a descriptor's publicKey" eq \
  "$(bash -c ". '$DEPLOY/lib/doctor.sh'; desc_key '{\"publicKey\":\"$FP_KEY\",\"publicKeyJwk\":{\"x\":\"y\"}}'")" "$FP_KEY"
check "  … and nothing for a malformed key" eq "$(bash -c ". '$DEPLOY/lib/doctor.sh'; fed_fingerprint AAEC")" ""
# ---- the 44Net name: a name under the call, never the base name ------------------------------------------------
n44f() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/net44.sh'; \"\$@\"" _ "$@"; }
fails() { ! "$@"; }
printf 'ADMIN_CALLSIGNS=OE8APR-10,OE1XYZ\n' >"$TMP/n44.env"
check "the default 44Net name is aprscaching.<call>.ampr.org, from ADMIN_CALLSIGNS' base call" eq \
  "$(SHAPE=selfhost SHAPE_ENV="$TMP/n44.env" n44f n44_default_name)" "aprscaching.oe8apr.ampr.org"
check "  … and aprscaching-pocket.<call>.ampr.org on Pocket" eq \
  "$(SHAPE=pocket SHAPE_ENV="$TMP/n44.env" n44f n44_default_name)" "aprscaching-pocket.oe8apr.ampr.org"
check "  … and nothing without a call" eq "$(SHAPE=selfhost SHAPE_ENV="" n44f n44_default_name)" ""
check "a name under the call is an instance name" n44f n44_valid_name aprscaching.oe8apr.ampr.org
check "  … the base name is not" fails n44f n44_valid_name oe8apr.ampr.org
check "  … nor a name outside ampr.org" fails n44f n44_valid_name aprscaching.example.net
check "the Portal records of the default name: A aprscaching, TXT _aprscaching" eq \
  "$(n44f n44_records aprscaching.oe8apr.ampr.org 44.1.2.3 aprs.example.net)" \
  "$(printf '%s\n' 'aprscaching  A    44.1.2.3' '_aprscaching  TXT  "v=acs1; inst=aprs.example.net; key=<federation key>"')"
check "  … naming both places for an instance with a public https origin" eq \
  "$(n44f n44_records aprscaching.oe8apr.ampr.org 44.1.2.3 aprs.example.net https://aprs.example.net | tail -n 1)" \
  '_aprscaching  TXT  "v=acs1; inst=aprs.example.net; key=<federation key>; host=aprscaching.oe8apr.ampr.org; web=https://aprs.example.net"'
printf 'APP_URL=https://APRS.example.net:443/app\n' >"$TMP/w1.env"
printf 'APP_URL=https://192.168.1.10\n' >"$TMP/w2.env"
printf 'APP_URL=http://aprs.example.net\n' >"$TMP/w3.env"
check "the public https origin comes from APP_URL" eq "$(SHAPE_ENV="$TMP/w1.env" n44f n44_web)" "https://aprs.example.net"
check "  … and the instance id from its host" eq "$(SHAPE_ENV="$TMP/w1.env" n44f n44_instance)" "aprs.example.net"
check "  … a private address or plain http is none" eq \
  "$(SHAPE_ENV="$TMP/w2.env" n44f n44_web)$(SHAPE_ENV="$TMP/w3.env" n44f n44_web)" ""
check "  … and of another name, under its own label" eq \
  "$(n44f n44_records aprscaching-pocket.oe8apr.ampr.org | cut -d' ' -f1)" \
  "$(printf '%s\n' aprscaching-pocket _aprscaching.aprscaching-pocket)"
ID_BODY='{"applicable":true,"lines":[{"id":"txt","status":"fail","label":"Identity TXT","detail":"no TXT record","fix":"Publish TXT _aprscaching.oe8apr.ampr.org \"v=acs1; inst=a; key=k\"."}]}'
check "doctor relays the identity self-check's lines, the fix with the value to publish" eq \
  "$(bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh'; doc_identity_lines '$ID_BODY'")" \
  "$(printf 'txt\tfail\tIdentity TXT: no TXT record\tPublish TXT _aprscaching.oe8apr.ampr.org "v=acs1; inst=a; key=k".')"
if have python3; then
  check "the checklist is read without node, with python3" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh';
    have() { [ \"\$1\" != node ] && command -v \"\$1\" >/dev/null; };
    doc_setup_items '{\"items\":[{\"key\":\"k\",\"label\":\"L\",\"level\":\"blocking\",\"status\":\"ok\",\"detail\":\"d\"}]}' | grep -q \$'k\tblocking\tok\tL: d'"
fi

# ---- the CLI reference names every option the help prints ---------------------------------------------------
CLI="$DEPLOY/../docs/reference/cli.md"
for c in "help" "init selfhost --help" "init baremetal --help" "init ingest-box --help" \
  "--shape selfhost backup --help" "--shape selfhost restore x --help" "--shape selfhost update --help" \
  "--shape selfhost net44 setup --help" "status --help" "doctor --help" "rotate-secret --help"; do
  missing=""
  # shellcheck disable=SC2086 # the words of the command
  for f in $("$H" $c 2>&1 | grep -oE -- "--[a-z][a-z0-9-]+" | sort -u); do grep -qF -- "\`$f" "$CLI" || missing="$missing $f"; done
  check "docs/reference/cli.md documents every option of '$c'" eq "${missing:-none}" none
done

# ---- the Pocket bootstrap: a release's copy installs only its checked bundle -----------------------------------
PK="$TMP/pocket"
mkdir -p "$PK/src/deploy/pocket" "$PK/rel/vtest" "$PK/raw/main/deploy/pocket"
# a stand-in repository whose install.sh records how it was called
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >"$POCKET_CALLED"' >"$PK/src/deploy/pocket/install.sh"
printf '%s\n' 'pocket_paths() { :; }' >"$PK/src/deploy/pocket/lib.sh"
cp "$PK/src/deploy/pocket/install.sh" "$PK/raw/main/deploy/pocket/install.sh"
git -C "$PK/src" init -q && git -C "$PK/src" add . &&
  git -C "$PK/src" -c user.name=t -c user.email=t@example.org commit -qm stub && git -C "$PK/src" tag vtest
git -C "$PK/src" bundle create -q "$PK/rel/vtest/aprscaching-vtest.bundle" refs/tags/vtest 2>/dev/null
sum="$(sha256sum "$PK/rel/vtest/aprscaching-vtest.bundle" | cut -d' ' -f1)"
stamp() { sed -e "s/^POCKET_RELEASE=\"\"/POCKET_RELEASE=\"vtest\"/" -e "s/^POCKET_BUNDLE_SHA256=\"\"/POCKET_BUNDLE_SHA256=\"$1\"/" \
  "$DEPLOY/pocket/pocket.sh" >"$PK/pocket.sh"; }
pocket() { # pocket DIR [args…]: no terminal, so nothing can be asked
  local d="$1"
  shift
  POCKET_CALLED="$PK/called" APRSCACHING_RELEASES="file://$PK/rel" APRSCACHING_RAW="file://$PK/raw" \
    bash "$PK/pocket.sh" --allow-non-termux --no-start --call OE8APR --dir "$d" --data-dir "$PK/data" "$@" \
    </dev/null >"$PK/out" 2>&1
}
stamp "$sum"
rm -f "$PK/called"
check "pocket.sh from a release installs its bundle" pocket "$PK/a"
check "  … checked out at the release's tag" eq "$(git -C "$PK/a" describe --tags 2>/dev/null)" vtest
check "  … with origin left at the repository" eq "$(git -C "$PK/a" remote get-url origin)" https://github.com/apachler/aprscaching.git
check "  … and runs that release's install.sh, never updating past it" grep -q -- "--no-update" "$PK/called"
stamp "$(printf '0%.0s' $(seq 64))"
rm -f "$PK/called"
check "pocket.sh refuses a bundle that does not match its checksum" bash -c "! POCKET_CALLED='$PK/called' APRSCACHING_RELEASES='file://$PK/rel' bash '$PK/pocket.sh' --allow-non-termux --no-start --call OE8APR --dir '$PK/b' --data-dir '$PK/data' </dev/null >'$PK/out' 2>&1"
check "  … and installs nothing" bash -c "[ ! -e '$PK/b' ] && [ ! -e '$PK/called' ] && grep -q 'does not match the checksum' '$PK/out'"
cp "$DEPLOY/pocket/pocket.sh" "$PK/pocket.sh"
check "pocket.sh will not install a branch unasked without a terminal" bash -c "! POCKET_CALLED='$PK/called' bash '$PK/pocket.sh' --allow-non-termux --no-start --call OE8APR --dir '$PK/c' </dev/null >'$PK/out' 2>&1"
check "  … and says it is unverified" grep -q "needs --unverified" "$PK/out"
mkdir -p "$PK/c/deploy/pocket" && cp "$PK/src/deploy/pocket/lib.sh" "$PK/c/deploy/pocket/" # the stub clones nothing
check "pocket.sh installs a branch with --unverified" pocket "$PK/c" --unverified
check "  … through that branch's install.sh" grep -q -- "--branch main" "$PK/called"

# ---- deploy/cloudflare/cache-rules.sh, against a mocked curl ----------------------------------------------
CF="$TMP/cf"
mkdir -p "$CF/bin"
# the stub keeps the ruleset it was sent and answers as $CF_ANSWER says
cat >"$CF/bin/curl" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = --data ] && { printf '%s' "$2" >"$CF_SENT"; shift; }; shift; done
printf '%s' "$CF_ANSWER"
STUB
chmod +x "$CF/bin/curl"
cache_rules() { # cache_rules ANSWER: runs the script against the stub
  PATH="$CF/bin:$PATH" CF_SENT="$CF/sent" CF_ANSWER="$1" CF_API_TOKEN=t CF_ZONE_ID=z \
    bash "$DEPLOY/cloudflare/cache-rules.sh" >"$CF/out" 2>&1
}
rm -f "$CF/sent"
check "cache-rules.sh succeeds when Cloudflare accepts the rules" cache_rules '{"success":true,"errors":[]}'
assets_rule() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rules.find((x)=>x.expression.includes("/assets/")); console.log(JSON.stringify(r.action_parameters.edge_ttl.status_code_ttl ?? null))' "$CF/sent"; }
check "  … and keeps no error answer at the edge, whatever the edge TTL of /assets/" \
  eq "$(assets_rule)" '[{"status_code_range":{"from":400,"to":599},"value":-1}]'
check "cache-rules.sh fails when Cloudflare rejects the rules" \
  bash -c "! PATH='$CF/bin:$PATH' CF_SENT='$CF/sent' CF_ANSWER='{\"success\":false,\"errors\":[{\"message\":\"bad rule\"}]}' CF_API_TOKEN=t CF_ZONE_ID=z bash '$DEPLOY/cloudflare/cache-rules.sh' >'$CF/out' 2>&1"
check "  … and quotes what Cloudflare said" grep -q "bad rule" "$CF/out"

if [ "$FAILED" = 0 ]; then echo; echo "all helper checks passed"; else echo; echo "helper checks FAILED"; exit 1; fi
