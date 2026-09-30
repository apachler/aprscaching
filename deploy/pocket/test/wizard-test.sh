#!/usr/bin/env bash
# Fixture tests for wizard.sh: answers in the terminal (stdin) and in Android dialogs (a fake
# termux-dialog replaying JSON answers), validation, a rerun that keeps the values, cancelling, and
# --dry-run. Runs anywhere with bash and node; no Termux, no gateway.
#
#   bash deploy/pocket/test/wizard-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WIZARD="$ROOT/deploy/pocket/wizard.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  FAILS=$((FAILS + 1))
}
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$3', got '$2'"; fi; }
val() { { grep -E "^$1=" "$DATA/.env" || true; } | tail -n 1 | cut -d= -f2-; }

# A fresh data directory with the Pocket .env template and no database.
fresh() {
  DATA="$WORK/data.$1"
  export HOME="$WORK/home.$1"
  mkdir -p "$DATA" "$HOME"
  cp "$ROOT/deploy/pocket/.env.pocket.example" "$DATA/.env"
}
# Run the wizard in the terminal with ANSWERS on stdin; its output lands in $OUT.
text_run() {
  local answers="$1"
  shift
  OUT="$(printf '%b' "$answers" | PATH="$WORK/nobin:$PATH" bash "$WIZARD" --text --dir "$ROOT" --data-dir "$DATA" "$@" 2>&1)"
}

mkdir -p "$WORK/nobin"

# ---- 1. first run in the terminal: callsign, suggested instance name, no extras -----------------------
fresh 1
text_run 'oe8apr\n\nn\nn\nn\ny\n'
check "first run: callsign" "$(val ADMIN_CALLSIGNS)" OE8APR
check "first run: APRS-IS login follows the callsign" "$(val APRSIS_CALLSIGN)" OE8APR
check "first run: suggested instance name" "$(val INSTANCE)" oe8apr-pocket
case "$OUT" in *"?view=admin"*) pass "first run: hands over to Instance admin" ;; *) fail "first run: no admin URL" ;; esac

# ---- 2. invalid answers are asked again --------------------------------------------------------------
fresh 2
text_run 'OE8APR-12\nxy\nOE8APR\nBad_Name\nlocalhost\nOE8APR.ampr.org.\nn\nn\nn\ny\n'
check "validation: SSID and short call refused, then accepted" "$(val ADMIN_CALLSIGNS)" OE8APR
check "validation: instance name lowercased, trailing dot dropped" "$(val INSTANCE)" oe8apr.ampr.org
case "$OUT" in *"'OE8APR-12' is not a base callsign"*) pass "validation: SSID named" ;; *) fail "validation: SSID warning missing" ;; esac
case "$OUT" in *"'localhost' is not an instance name"*) pass "validation: localhost refused" ;; *) fail "validation: localhost accepted" ;; esac

# ---- 3. a rerun shows the current values and keeps them ---------------------------------------------
before="$(cat "$DATA/.env")"
text_run '\nn\nn\nn\n'
check "rerun: .env unchanged" "$(cat "$DATA/.env")" "$before"
case "$OUT" in *"[OE8APR]"*) pass "rerun: current callsign shown" ;; *) fail "rerun: current callsign not shown" ;; esac
case "$OUT" in *"instance name: oe8apr.ampr.org (set once"*) pass "rerun: instance name kept, not asked" ;; *) fail "rerun: instance name asked again" ;; esac
case "$OUT" in *"nothing to change"*) pass "rerun: nothing to change" ;; *) fail "rerun: changes reported" ;; esac

# ---- 4. a new callsign on a rerun keeps further admin calls ------------------------------------------
sed -i 's/^ADMIN_CALLSIGNS=.*/ADMIN_CALLSIGNS=OE8APR,OE8XYZ/' "$DATA/.env"
text_run 'oe8abc\nn\nn\nn\ny\n'
check "new call: first admin call replaced, others kept" "$(val ADMIN_CALLSIGNS)" OE8ABC,OE8XYZ

# ---- 5. cancelling changes nothing -------------------------------------------------------------------
fresh 5
before="$(cat "$DATA/.env")"
status=0
text_run 'OE8APR\n' || status=$?
check "cancel: exit status" "$status" 1
check "cancel: .env unchanged" "$(cat "$DATA/.env")" "$before"
fresh 5b
before="$(cat "$DATA/.env")"
status=0
text_run 'OE8APR\n\nn\nn\nn\nn\n' || status=$?
check "declined summary: exit status" "$status" 1
check "declined summary: .env unchanged" "$(cat "$DATA/.env")" "$before"

# ---- 6. --dry-run writes nothing ---------------------------------------------------------------------
fresh 6
before="$(cat "$DATA/.env")"
text_run 'OE8APR\n\nn\ny\ny\ny\n' --dry-run
check "dry-run: .env unchanged" "$(cat "$DATA/.env")" "$before"
case "$OUT" in *"[dry-run] ADMIN_CALLSIGNS=OE8APR"*"[dry-run] bash"*"extras/setup.sh --shortcuts --scheduled-backup"*) pass "dry-run: prints the changes" ;; *) fail "dry-run: output: $OUT" ;; esac

# ---- 7. Android dialogs: a fake termux-dialog replays JSON answers -----------------------------------
fresh 7
BIN="$WORK/dialogbin"
QUEUE="$WORK/queue"
mkdir -p "$BIN" "$QUEUE"
cat >"$BIN/termux-battery-status" <<'EOF'
#!/usr/bin/env bash
echo '{"percentage":80,"status":"CHARGING"}'
EOF
# Each call answers with the next file of the queue, in name order.
cat >"$BIN/termux-dialog" <<EOF
#!/usr/bin/env bash
next="\$(ls "$QUEUE" | head -n 1)"
[ -n "\$next" ] || exit 1
cat "$QUEUE/\$next"
rm -f "$QUEUE/\$next"
EOF
chmod +x "$BIN"/*
printf '{"code":-1,"text":"oe7xyz"}' >"$QUEUE/01"
printf '{"code":-1,"text":""}' >"$QUEUE/02"
printf '{"code":0,"text":"no"}' >"$QUEUE/03"
printf '{"code":0,"text":"no"}' >"$QUEUE/04"
printf '{"code":0,"text":"no"}' >"$QUEUE/05"
printf '{"code":0,"text":"yes"}' >"$QUEUE/06"
OUT="$(PATH="$BIN:$PATH" bash "$WIZARD" --dir "$ROOT" --data-dir "$DATA" </dev/null 2>&1)"
check "dialogs: callsign" "$(val ADMIN_CALLSIGNS)" OE7XYZ
check "dialogs: empty answer takes the suggestion" "$(val INSTANCE)" oe7xyz-pocket
check "dialogs: every answer used" "$(find "$QUEUE" -type f | wc -l | tr -d ' ')" 0

fresh 7b
printf '{"code":-2,"text":""}' >"$QUEUE/01"
before="$(cat "$DATA/.env")"
status=0
OUT="$(PATH="$BIN:$PATH" bash "$WIZARD" --dir "$ROOT" --data-dir "$DATA" </dev/null 2>&1)" || status=$?
check "dialogs: Cancel ends the wizard" "$status" 1
check "dialogs: Cancel changes nothing" "$(cat "$DATA/.env")" "$before"

# ---- 8. a station holding records keeps its instance name --------------------------------------------
if (cd "$ROOT/servers/node" && node -e "require('better-sqlite3')") >/dev/null 2>&1; then
  fresh 8
  db="$DATA/aprscaching.db"
  (cd "$ROOT/servers/node" && DB="$db" node -e '
    const D = require("better-sqlite3"); const db = new D(process.env.DB);
    db.exec("CREATE TABLE caches (id INTEGER); INSERT INTO caches VALUES (1)"); db.close();')
  sed -i "s#^DB_PATH=.*#DB_PATH=$db#" "$DATA/.env"
  text_run 'OE8APR\nn\nn\nn\ny\n'
  check "records: instance name not set" "$(val INSTANCE)" ""
  case "$OUT" in *"instance name: localhost (the station holds caches or finds"*) pass "records: says why" ;; *) fail "records: no reason given" ;; esac
else
  printf 'skip records: better-sqlite3 is not installed in servers/node\n'
fi

if [ "$FAILS" -gt 0 ]; then
  printf '\n%s check(s) failed\n' "$FAILS"
  exit 1
fi
printf '\nall wizard checks passed\n'
