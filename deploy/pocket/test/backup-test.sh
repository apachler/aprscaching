#!/usr/bin/env bash
# Fixture tests for backup.sh and extras/scheduled-backup.sh: where the instance secrets (.env, *.secret) go.
# An archive on shared storage never holds them, they wait in private storage and --restore takes them back;
# an archive elsewhere holds them; --no-env and --with-secrets decide it yourself. A stand-in better-sqlite3
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

# ---- 1. the default: shared storage, the secrets kept private -------------------------------------------
station 1
backup
shared="$HOME/storage/shared/aprscaching-backups"
archive="$(newest "$shared" 'aprscaching-pocket-*.tar.gz')"
has "default: an archive on shared storage" "$archive"
in_tar "default: the archive holds the database" "$archive" aprscaching.db
not_in_tar "default: the archive holds no .env" "$archive" env
not_in_tar "default: the archive holds no session.secret" "$archive" session.secret
secrets="$DATA/backups/$(basename "$archive" .tar.gz)-secrets.tar.gz"
has "default: the secrets beside it in private storage" "$secrets"
in_tar "default: the private archive holds the .env" "$secrets" env
in_tar "default: the private archive holds session.secret" "$secrets" session.secret
mode "default: the private archive is the owner's only" "$secrets" 600
mode "default: the private directory is the owner's only" "$DATA/backups" 700

# ---- 2. --restore takes the secrets back from private storage -------------------------------------------
printf 'session-changed\n' >"$DATA/session.secret"
printf 'db-changed\n' >"$DATA/aprscaching.db"
bash "$POCKET/backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" --restore "$archive" --with-env >"$WORK/out" 2>&1 \
  || fail "restore: exits 0 ($(tail -n 3 "$WORK/out"))"
if [ "$(cat "$DATA/aprscaching.db")" = db-1 ]; then pass "restore: the database"; else fail "restore: the database"; fi
if [ "$(cat "$DATA/session.secret")" = session-1 ]; then pass "restore: session.secret from private storage"; else fail "restore: session.secret is $(cat "$DATA/session.secret")"; fi

# ---- 3. a private destination keeps the secrets in the archive ------------------------------------------
station 3
mkdir -p "$WORK/private3"
backup --dest "$WORK/private3"
archive="$(newest "$WORK/private3" 'aprscaching-pocket-*.tar.gz')"
in_tar "private destination: the archive holds the .env" "$archive" env
in_tar "private destination: the archive holds session.secret" "$archive" session.secret
lacks "private destination: nothing beside it" "$DATA/backups"

# ---- 4. --no-env and --with-secrets ----------------------------------------------------------------------
station 4
backup --no-env
archive="$(newest "$HOME/storage/shared/aprscaching-backups" 'aprscaching-pocket-*.tar.gz')"
not_in_tar "--no-env: no .env" "$archive" env
lacks "--no-env: no private secrets either" "$DATA/backups"
sleep 1
backup --with-secrets
archive="$(newest "$HOME/storage/shared/aprscaching-backups" 'aprscaching-pocket-*.tar.gz')"
in_tar "--with-secrets: the .env in the shared archive" "$archive" env
if grep -q "lies on shared storage" "$WORK/out"; then pass "--with-secrets: warns"; else fail "--with-secrets: no warning"; fi

# ---- 5. the scheduled backup takes the default -----------------------------------------------------------
station 5
mkdir -p "$WORK/bin5"
printf '#!/bin/sh\necho %s\n' "'{\"percentage\":80}'" >"$WORK/bin5/termux-battery-status"
chmod +x "$WORK/bin5/termux-battery-status"
PATH="$WORK/bin5:$PATH" bash "$POCKET/extras/scheduled-backup.sh" --dir "$CHECKOUT" --data-dir "$DATA" \
  || fail "scheduled backup: exits 0 ($(tail -n 3 "$DATA/logs/scheduled-backup.log"))"
archive="$(newest "$HOME/storage/shared/aprscaching-backups" 'aprscaching-pocket-*.tar.gz')"
has "scheduled backup: an archive on shared storage" "$archive"
not_in_tar "scheduled backup: the archive holds no .env" "$archive" env
not_in_tar "scheduled backup: the archive holds no session.secret" "$archive" session.secret

if [ "$CHECKS" -eq 0 ]; then
  echo "no checks ran" >&2
  exit 1
fi
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS of $CHECKS checks failed" >&2
  exit 1
fi
echo "all $CHECKS checks passed"
