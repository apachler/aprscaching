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
check "a shape without a command explains it" bash -c "'$H' --shape desktop update 2>&1 | grep -q 'not available for the desktop shape'"
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

# ---- setup.sh: the federation posture ---------------------------------------------------------------------
S="$DEPLOY/setup.sh"
setup() { "$S" --non-interactive --no-network "$@" </dev/null >"$TMP/out" 2>"$TMP/err"; }
P="$TMP/pub.env"
check "a public instance is set up" setup --env-file "$P" --call OE8APR --domain aprs.example.net \
  --fed-peers https://peer.example.org --net44-name aprscaching.oe8apr.ampr.org
check "  … with auto-promotion off" eq "$(env_file_get "$P" FED_AUTO_PROMOTE)" "0"
check "  … with a corroboration quorum of 2" eq "$(env_file_get "$P" FED_CORROBORATION_QUORUM)" "2"
check "  … with discovery unset" bash -c "! grep -q '^FED_DISCOVER=' '$P'"
check "  … with the peers it was given" eq "$(env_file_get "$P" FED_PEERS)" "https://peer.example.org"
check "  … with the D1 write budget off" eq "$(env_file_get "$P" D1_DAILY_WRITE_BUDGET)" "0"
check "  … with its 44Net endpoint beside https" bash -c "grep -q '\"44net\",\"address\":\"aprscaching.oe8apr.ampr.org\"' '$P'"
if setup --env-file "$TMP/x.env" --call OE8APR --domain a.example.net --fed-peers https://gw.oe1xyz.ampr.org; then
  bad "a 44Net peer is refused for FED_PEERS"
else
  ok "a 44Net peer is refused for FED_PEERS"
fi
if setup --env-file "$TMP/y.env" --call OE8APR --domain a.example.net --fed-peers http://peer.example.org; then
  bad "a plain-http peer is refused"
else
  ok "a plain-http peer is refused"
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
L="$TMP/lan.env"
check "a LAN instance is set up" setup --env-file "$L" --call OE8APR --lan-host 10.0.0.5 --app-port 8080
check "  … on its own port" eq "$(env_file_get "$L" APP_URL)" "http://10.0.0.5:8080"
check "  … with no federation peers" eq "$(env_file_get "$L" FED_PEERS)" ""
if setup --env-file "$TMP/t.env" --call OE8APR --domain a.example.net --tunnel-token t --no-tunnel; then
  bad "--no-tunnel refuses a tunnel token"
else
  ok "--no-tunnel refuses a tunnel token"
fi
check "--no-next-steps prints no Docker steps" bash -c "! '$S' --non-interactive --no-network --env-file '$L' --call OE8APR --lan-host 10.0.0.5 --no-next-steps </dev/null | grep -q 'docker compose'"

# ---- bare metal ------------------------------------------------------------------------------------------------
if have systemctl && have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  check "bare metal: a dry run" run --yes init baremetal --dry-run --ref main --dir /srv/acs --user acs --port 8090 --call OE8APR
  check "  … lists the root steps first" grep -q "Steps that need root" "$TMP/out"
  check "  … creates the user as root" grep -q "\[root\] useradd --system .* acs" "$TMP/out"
  check "  … clones as the service user" grep -q "\[acs\] git clone" "$TMP/out"
  check "  … writes the .env through setup.sh on its port" grep -q "setup.sh --env-file /srv/acs/deploy/.env --app-port 8090 --no-tunnel" "$TMP/out"
  check "  … enables both units" grep -q "systemctl enable --now aprscaching-gateway aprscaching-ingest" "$TMP/out"
  check "  … says the checkout is unverified" grep -q "without verification" "$TMP/err"
  check "  … records nothing" test ! -e "$APRSCACHING_SHAPE_FILE"
  check "bare metal: --no-start leaves systemd alone" run --yes init baremetal --dry-run --ref main --no-start --call OE8APR
  check "  … no systemctl" bash -c "! grep -q '\[root\] systemctl' '$TMP/out'"
  if run --non-interactive init baremetal --dry-run --ref main --call OE8APR; then
    bad "bare metal: an unverified install without --yes is refused"
  else
    ok "bare metal: an unverified install without --yes is refused"
  fi
else
  echo "skip bare metal (needs systemctl and Node.js 22+)"
fi
render() {
  bash -c "APRS_INTERACTIVE=0; . '$DEPLOY/lib/common.sh'; DEPLOY_DIR='$DEPLOY'; . '$DEPLOY/lib/shapes/baremetal.sh';
    BM_DIR=/srv/acs BM_USER=acs BM_PORT=8090; bm_render_unit '$DEPLOY/systemd/aprscaching-gateway.service'"
}
U="$(render)"
check "a rendered unit uses the install directory" bash -c "grep -q '^WorkingDirectory=/srv/acs\$' <<<'$U' && ! grep -q /opt/aprscaching <<<'$U'"
check "  … the service user" bash -c "grep -q '^User=acs\$' <<<'$U'"
check "  … the port" bash -c "grep -q '^Environment=PORT=8090\$' <<<'$U'"
check "  … the web app" bash -c "grep -q '^Environment=WEB_DIST=/srv/acs/apps/web/dist\$' <<<'$U'"
check "  … pnpm by absolute path" bash -c "grep -qE '^ExecStart=/[^ ]*(pnpm|corepack pnpm) --filter @aprscaching/node-gateway start\$' <<<'$U'"

# ---- doctor ------------------------------------------------------------------------------------------------
# A stub gateway (fixtures/stub-gateway.py) answers on a free port; doctor checks it through the Pocket
# context, whose settings live in one .env.
if have python3; then
  PORT_STUB="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  ING="ingest-0123456789abcdef0123456789" OPS="operator-0123456789abcdef01234567"
  STUB_INGEST="$ING" STUB_OPERATOR="$OPS" STUB_SCHEMA=0001_baseline.sql \
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
    check "  … the write budget is relayed" eq "$(status_of setup.budget)" pass
    check "  … a LAN instance has federation off" eq "$(status_of federation.off)" pass
    check "  … a recent backup passes" eq "$(status_of resources.backup)" pass
    check "  … the source link passes" eq "$(status_of source.link)" pass
    check "  … no secret appears in the report" bash -c "! grep -qE '$ING|$OPS' '$TMP/out' '$TMP/err'"
    chmod 600 "$PD/.env"
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
check "MeshCom firmware 4.35t is new enough" bash -c ". '$DEPLOY/lib/doctor.sh'; fw_at_least 4.35t 4 35 t"
check "  … 4.36 too" bash -c ". '$DEPLOY/lib/doctor.sh'; fw_at_least v4.36 4 35 t"
check "  … 4.35s is not" bash -c ". '$DEPLOY/lib/doctor.sh'; ! fw_at_least 4.35s 4 35 t"
check "  … 4.34z is not" bash -c ". '$DEPLOY/lib/doctor.sh'; ! fw_at_least 4.34z 4 35 t"
if have python3; then
  check "the checklist is read without node, with python3" bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/doctor.sh';
    have() { [ \"\$1\" != node ] && command -v \"\$1\" >/dev/null; };
    doc_setup_items '{\"items\":[{\"key\":\"k\",\"label\":\"L\",\"level\":\"blocking\",\"status\":\"ok\",\"detail\":\"d\"}]}' | grep -q \$'k\tblocking\tok\tL: d'"
fi

if [ "$FAILED" = 0 ]; then echo; echo "all helper checks passed"; else echo; echo "helper checks FAILED"; exit 1; fi
