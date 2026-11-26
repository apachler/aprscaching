#!/usr/bin/env bash
# Fixture tests for backup.sh and extras/scheduled-backup.sh: where the archives and the instance secrets (.env,
# *.secret) go. The archive stays in Termux's private folder unless --dest names another; the secrets always wait
# in private storage, and --restore takes them only from there, never from the archive it is handed. A stand-in better-sqlite3
# copies the database, so this runs anywhere with bash and node; no Termux, no gateway.
#
#   bash deploy/pocket/test/backup-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POCKET="$ROOT/deploy/pocket"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
CHECKS=0

pass() {
  printf 'ok   %s\n' "$1"
  CHECKS=$((CHECKS + 1))
}
fail() {
  printf 'FAIL %s\n' "$1"
  CHECKS=$((CHECKS + 1))
  FAILS=$((FAILS + 1))
}
has() { if [ -e "$2" ]; then pass "$1"; else fail "$1: $2 is missing"; fi; }
lacks() { if [ ! -e "$2" ]; then pass "$1"; else fail "$1: $2 is there"; fi; }
mode() { if [ "$(stat -c %a "$2")" = "$3" ]; then pass "$1"; else fail "$1: $2 is $(stat -c %a "$2"), not $3"; fi; }
# The entries of an archive, one per line.
entries() { tar -tzf "$1" | sed 's|^[^/]*/||'; }
in_tar() { if entries "$2" | grep -qx "$3"; then pass "$1"; else fail "$1: $2 has no $3"; fi; }
not_in_tar() { if ! entries "$2" | grep -qx "$3"; then pass "$1"; else fail "$1: $2 holds $3"; fi; }

# A checkout whose servers/node resolves a stand-in better-sqlite3: backup copies the file, every check is ok.
CHECKOUT="$WORK/checkout"
mkdir -p "$CHECKOUT/servers/node/node_modules/better-sqlite3"
cat >"$CHECKOUT/servers/node/node_modules/better-sqlite3/index.js" <<'JS'
const fs = require("fs");
module.exports = class Database {
  constructor(p) { this.p = p; }
  backup(dst) { fs.copyFileSync(this.p, dst); return Promise.resolve(); }
  pragma() { return "ok"; }
  prepare() { return { get: () => ({ n: 3 }) }; }
  close() {}
};
JS

# A station: HOME with shared storage, a data directory with a .env, a database and session.secret.
station() {
  export HOME="$WORK/home.$1"
  DATA="$WORK/data.$1"
  mkdir -p "$HOME/storage/shared" "$DATA"
  printf 'INGEST_SECRET=ingest-%s\nOPERATOR_SECRET=operator-%s\n' "$1" "$1" >"$DATA/.env"
  printf 'db-%s\n' "$1" >"$DATA/aprscaching.db"
  printf 'session-%s\n' "$1" >"$DATA/session.secret"
}
backup() { bash "$POCKET/backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" "$@" >"$WORK/out" 2>&1; }
newest() { find "$1" -maxdepth 1 -name "$2" | sort | tail -n 1; }

# Nothing under the phone's shared storage, as a list of paths (empty when nothing).
shared_files() { find "$HOME/storage/shared" -mindepth 1 2>/dev/null; }
nothing_shared() { if [ -z "$(shared_files)" ]; then pass "$1"; else fail "$1: $(shared_files | tr '\n' ' ')"; fi; }

# ---- 1. the default: Termux's private folder, nothing on shared storage -----------------------------------
station 1
backup
private="$DATA/backups"
archive="$(newest "$private" 'aprscaching-pocket-*Z.tar.gz')"
has "default: an archive in Termux's private folder" "$archive"
nothing_shared "default: nothing written under shared storage"
in_tar "default: the archive holds the database" "$archive" aprscaching.db
not_in_tar "default: the archive holds no .env" "$archive" env
not_in_tar "default: the archive holds no session.secret" "$archive" session.secret
secrets="$private/$(basename "$archive" .tar.gz)-secrets.tar.gz"
has "default: the secrets beside it in private storage" "$secrets"
in_tar "default: the private archive holds the .env" "$secrets" env
in_tar "default: the private archive holds session.secret" "$secrets" session.secret
mode "default: the private archive is the owner's only" "$secrets" 600
mode "default: the private directory is the owner's only" "$private" 700

# ---- 2. --restore takes the secrets back from private storage -------------------------------------------
printf 'session-changed\n' >"$DATA/session.secret"
printf 'db-changed\n' >"$DATA/aprscaching.db"
bash "$POCKET/backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" --restore "$archive" --with-env >"$WORK/out" 2>&1 \
  || fail "restore: exits 0 ($(tail -n 3 "$WORK/out"))"
if [ "$(cat "$DATA/aprscaching.db")" = db-1 ]; then pass "restore: the database"; else fail "restore: the database"; fi
if [ "$(cat "$DATA/session.secret")" = session-1 ]; then pass "restore: session.secret from private storage"; else fail "restore: session.secret is $(cat "$DATA/session.secret")"; fi
if grep -qx 'INGEST_SECRET=ingest-1' "$DATA/.env"; then pass "restore: the .env from private storage"; else fail "restore: the .env is $(cat "$DATA/.env")"; fi
if grep -q 'manifest:' "$WORK/out" && grep -q 'contains: database' "$WORK/out"; then pass "restore: shows the manifest"; else fail "restore: no manifest shown"; fi

# ---- 3. --dest on shared storage: written there, with a warning, still without the secrets ----------------
station 3
backup --dest "$HOME/storage/shared/aprscaching-backups"
archive="$(newest "$HOME/storage/shared/aprscaching-backups" 'aprscaching-pocket-*Z.tar.gz')"
has "--dest shared storage: the archive is written there" "$archive"
not_in_tar "--dest shared storage: the archive holds no .env" "$archive" env
not_in_tar "--dest shared storage: the archive holds no session.secret" "$archive" session.secret
has "--dest shared storage: the secrets in private storage" "$DATA/backups/$(basename "$archive" .tar.gz)-secrets.tar.gz"
if grep -q "lies on shared storage" "$WORK/out"; then pass "--dest shared storage: warns"; else fail "--dest shared storage: no warning"; fi

# ---- 4. --no-env and --with-secrets ----------------------------------------------------------------------
station 4
backup --no-env
archive="$(newest "$DATA/backups" 'aprscaching-pocket-*Z.tar.gz')"
not_in_tar "--no-env: no .env" "$archive" env
if [ -z "$(find "$DATA/backups" -name '*-secrets.tar.gz')" ]; then pass "--no-env: no private secrets either"; else fail "--no-env: a secrets archive was written"; fi
sleep 1
backup --with-secrets
archive="$(newest "$DATA/backups" 'aprscaching-pocket-*Z.tar.gz')"
in_tar "--with-secrets: the .env in the archive" "$archive" env
in_tar "--with-secrets: session.secret in the archive" "$archive" session.secret
nothing_shared "--with-secrets: nothing written under shared storage"

# ---- 5. the scheduled backup takes the default -----------------------------------------------------------
station 5
mkdir -p "$WORK/bin5"
printf '#!/bin/sh\necho %s\n' "'{\"percentage\":80}'" >"$WORK/bin5/termux-battery-status"
chmod +x "$WORK/bin5/termux-battery-status"
PATH="$WORK/bin5:$PATH" bash "$POCKET/extras/scheduled-backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" \
  || fail "scheduled backup: exits 0 ($(tail -n 3 "$DATA/logs/scheduled-backup.log"))"
archive="$(newest "$DATA/backups" 'aprscaching-pocket-*Z.tar.gz')"
has "scheduled backup: an archive in Termux's private folder" "$archive"
nothing_shared "scheduled backup: nothing written under shared storage"
not_in_tar "scheduled backup: the archive holds no .env" "$archive" env
not_in_tar "scheduled backup: the archive holds no session.secret" "$archive" session.secret

# ---- 6. a session.secret planted in an archive on shared storage is never installed ------------------------
station 6
plant="$WORK/plant6/aprscaching-pocket-20990101T000000Z"
mkdir -p "$plant" "$HOME/storage/shared/Download"
printf 'db-planted\n' >"$plant/aprscaching.db"
printf 'session-planted\n' >"$plant/session.secret"
printf 'OPERATOR_SECRET=planted\n' >"$plant/env"
printf 'APRScaching Pocket backup\nsecrets: x\n' >"$plant/MANIFEST"
planted="$HOME/storage/shared/Download/aprscaching-pocket-20990101T000000Z.tar.gz"
tar -czf "$planted" -C "$WORK/plant6" "$(basename "$plant")"
bash "$POCKET/backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" --restore "$planted" --with-env >"$WORK/out" 2>&1 \
  || fail "planted archive: exits 0 ($(tail -n 3 "$WORK/out"))"
if [ "$(cat "$DATA/session.secret")" = session-6 ]; then pass "planted archive: session.secret not installed"; else fail "planted archive: session.secret is $(cat "$DATA/session.secret")"; fi
if grep -qx 'OPERATOR_SECRET=operator-6' "$DATA/.env"; then pass "planted archive: its .env not installed"; else fail "planted archive: the .env is $(cat "$DATA/.env")"; fi
if grep -q "ignored in the archive: env session.secret" "$WORK/out"; then pass "planted archive: says what it ignored"; else fail "planted archive: no message ($(tail -n 5 "$WORK/out"))"; fi

# ---- 7. --with-env writes known settings only, none in a form the scripts' shell would run -----------------
station 7
backup
archive="$(newest "$DATA/backups" 'aprscaching-pocket-*Z.tar.gz')"
secrets="$DATA/backups/$(basename "$archive" .tar.gz)-secrets.tar.gz"
name="$(basename "$archive" .tar.gz)"
mkdir -p "$WORK/sec7/$name"
printf '%s\n' "INGEST_SECRET=ingest-7" 'OPERATOR_SECRET=$(touch '"$WORK"'/ran7)' "APP_URL='http://192.168.43.1:8787'" \
  'NOT_A_SETTING=1' >"$WORK/sec7/$name/env"
(umask 077 && tar -czf "$secrets" -C "$WORK/sec7" "$name")
bash "$POCKET/backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" --restore "$archive" --with-env >"$WORK/out" 2>&1 \
  || fail "--with-env: exits 0 ($(tail -n 3 "$WORK/out"))"
if (set -a && . "$DATA/.env") && [ ! -e "$WORK/ran7" ]; then pass "--with-env: sourcing the .env runs nothing"; else fail "--with-env: the .env ran a command"; fi
if ! grep -q '^OPERATOR_SECRET=' "$DATA/.env" && grep -q "OPERATOR_SECRET" "$WORK/out"; then pass "--with-env: a value holding \$(…) is left out, named"; else fail "--with-env: OPERATOR_SECRET is $(grep OPERATOR_SECRET "$DATA/.env")"; fi
if grep -qx 'INGEST_SECRET=ingest-7' "$DATA/.env" && grep -qx 'APP_URL=http://192.168.43.1:8787' "$DATA/.env"; then pass "--with-env: known settings come back"; else fail "--with-env: the .env is $(cat "$DATA/.env")"; fi
if ! grep -q '^NOT_A_SETTING=' "$DATA/.env"; then pass "--with-env: an unknown key is not written"; else fail "--with-env: NOT_A_SETTING written"; fi

if [ "$CHECKS" -eq 0 ]; then
  echo "no checks ran" >&2
  exit 1
fi
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS of $CHECKS checks failed" >&2
  exit 1
fi
echo "all $CHECKS checks passed"
