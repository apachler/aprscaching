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
check "an enum value passes" cfg_check TRUST_PROXY 1
check "an unknown enum value fails" eq "$(cfg_check TRUST_PROXY true || true)" "TRUST_PROXY: expected one of: 0, 1"
check "a URL passes" cfg_check APP_URL https://aprs.example.net
check "a bare host fails as a URL" eq "$(cfg_check APP_URL aprs.example.net || true)" "APP_URL: expected an absolute URL"
if have node || have python3; then
  check "broken JSON fails" eq "$(cfg_check FED_KEY_HISTORY '[{' || true)" "FED_KEY_HISTORY: expected valid JSON"
  check "JSON passes" cfg_check FED_KEY_HISTORY '[]'
fi
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
check "an unknown command fails" bash -c "! '$H' frob 2>/dev/null"
check "an unknown shape fails" bash -c "! '$H' init mainframe 2>/dev/null"
check "a shape without a command explains it" bash -c "'$H' --shape baremetal status 2>&1 | grep -q 'not available for the baremetal shape'"
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

if [ "$FAILED" = 0 ]; then echo; echo "all helper checks passed"; else echo; echo "helper checks FAILED"; exit 1; fi
