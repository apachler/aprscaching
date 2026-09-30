#!/usr/bin/env bash
# Back up the Pocket station to the phone's shared storage: a consistent snapshot of the SQLite database
# (taken while the gateway runs), the .env with the secrets beside the database, and the uploaded media,
# packed as aprscaching-pocket-<UTC time>.tar.gz. Keeps the newest N archives. With --restore, puts an
# archive back in place.
#
#   termux-setup-storage                         # once: lets Termux write to shared storage
#   bash ~/aprscaching/deploy/pocket/backup.sh
#   bash ~/aprscaching/deploy/pocket/backup.sh --no-env --keep 14
#   bash ~/aprscaching/deploy/pocket/backup.sh --restore ~/storage/shared/aprscaching-backups/aprscaching-pocket-20260930T120000Z.tar.gz
#
# The snapshot uses SQLite's online backup API through better-sqlite3, which the gateway already needs,
# so no sqlite3 package is required; the copy is checked (quick_check) before it is packed.
#
# Shared storage has no per-app permissions: any app allowed to read storage can read the archive. The
# .env holds INGEST_SECRET and OPERATOR_SECRET and session.secret signs the sessions, so --no-env leaves
# them out when the archive is to stay on the phone or travel through a cloud folder.
#
# Options:
#   --dest DIR           where the archives go          (APRSCACHING_BACKUP_DIR,
#                                                        default ~/storage/shared/aprscaching-backups)
#   --keep N             archives to keep in DIR        (default 7)
#   --no-env             leave out the .env and the *.secret files
#   --media              include the media directory whatever its size
#   --no-media           leave the media directory out
#                        (default: included while it is at most APRSCACHING_BACKUP_MEDIA_MAX_MB, 50 MiB)
#   --restore FILE       stop the station, move the current database (and media, secrets) aside to
#                        ~/.aprscaching/before-restore-<time>/, put the archive's in place and start the
#                        station again if it was running; the .env is restored only with --with-env
#   --with-env           with --restore: restore the archive's .env too
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

DEST="${APRSCACHING_BACKUP_DIR:-}"
KEEP=7
WITH_SECRETS=1
MEDIA_MODE=auto
MEDIA_MAX_MB="${APRSCACHING_BACKUP_MEDIA_MAX_MB:-50}"
RESTORE=""
RESTORE_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; shift ;;
    --keep) KEEP="${2:-}"; shift ;;
    --no-env) WITH_SECRETS=0 ;;
    --media) MEDIA_MODE=yes ;;
    --no-media) MEDIA_MODE=no ;;
    --restore) RESTORE="${2:-}"; shift ;;
    --with-env) RESTORE_ENV=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
case "$KEEP" in '' | *[!0-9]* | 0) die "--keep takes a number of archives, at least 1 (got '$KEEP')." ;; esac

have node || die "node is missing." "Run deploy/pocket/install.sh first."
[ -d "$DIR/servers/node" ] || die "$DIR is not an aprscaching checkout." "Pass --dir PATH."
DB="$(env_get DB_PATH)"
DB="${DB:-$DATA/aprscaching.db}"
DB_DIR="$(dirname "$DB")"
MEDIA="$(env_get MEDIA_DIR)"
MEDIA="${MEDIA:-$DATA/media}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# Copy SRC to DST with the online backup API (consistent while the gateway writes), then check the copy.
# Prints the number of tables in the copy.
SNAPSHOT_JS='
const Database = require("better-sqlite3");
const [src, dst] = process.argv.slice(1);
const db = new Database(src, { fileMustExist: true, timeout: 10000 });
db.backup(dst)
  .then(() => {
    db.close();
    // The copy keeps the WAL mode of the source; a rollback journal makes it one self-contained file.
    const copy = new Database(dst, { fileMustExist: true });
    copy.pragma("journal_mode = DELETE");
    const check = copy.pragma("quick_check", { simple: true });
    const tables = copy.prepare("select count(*) n from sqlite_master where type = ?").get("table").n;
    copy.close();
    if (check !== "ok") throw new Error("quick_check: " + check);
    console.log(tables);
  })
  .catch((e) => { console.error(e.message); process.exit(1); });'
# Check an existing database file; prints the number of tables.
CHECK_JS='
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
const check = db.pragma("quick_check", { simple: true });
if (check !== "ok") { console.error("quick_check: " + check); process.exit(1); }
console.log(db.prepare("select count(*) n from sqlite_master where type = ?").get("table").n);'
node_sqlite() { (cd "$DIR/servers/node" && node -e "$@"); }

STAGE=""
cleanup() { if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi; }
trap cleanup EXIT

# ---- restore -----------------------------------------------------------------------------------------
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] || die "$RESTORE does not exist."
  step "Checking $RESTORE"
  mkdir -p "$DATA"
  STAGE="$(mktemp -d "$DATA/restore.XXXXXX")"
  tar -xzf "$RESTORE" -C "$STAGE"
  src="$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$src" ] && [ -f "$src/aprscaching.db" ] || die "$RESTORE is not a Pocket backup (no aprscaching.db inside)."
  tables="$(node_sqlite "$CHECK_JS" "$src/aprscaching.db")" || die "the database in $RESTORE fails its check."
  info "database: $tables tables, check ok"

  running=0
  if session_exists || is_ours "$(state_get gateway supervisor)" supervise.sh; then running=1; fi
  if [ "$running" -eq 1 ]; then
    bash "$HERE/stop.sh" --dir "$DIR" --data-dir "$DATA"
  fi
  if health_ok "$(gateway_base)"; then
    die "a gateway still answers on $(gateway_base); stop it, then run the restore again."
  fi

  aside="$DATA/before-restore-$TS"
  mkdir -p "$aside"
  chmod 700 "$aside"
  step "Moving the current files to $aside"
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    if [ -e "$f" ]; then mv "$f" "$aside/"; fi
  done
  mkdir -p "$DB_DIR"
  mv "$src/aprscaching.db" "$DB"
  chmod 600 "$DB"
  info "database restored to $DB"
  for f in "$src"/*.secret; do
    [ -e "$f" ] || continue
    if [ -e "$DB_DIR/$(basename "$f")" ]; then mv "$DB_DIR/$(basename "$f")" "$aside/"; fi
    mv "$f" "$DB_DIR/"
    chmod 600 "$DB_DIR/$(basename "$f")"
    info "$(basename "$f") restored"
  done
  if [ -d "$src/media" ]; then
    if [ -e "$MEDIA" ]; then mv "$MEDIA" "$aside/media"; fi
    mkdir -p "$(dirname "$MEDIA")"
    mv "$src/media" "$MEDIA"
    info "media restored to $MEDIA"
  fi
  if [ -f "$src/env" ]; then
    if [ "$RESTORE_ENV" -eq 1 ]; then
      if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$aside/.env"; fi
      cat "$src/env" >"$ENV_FILE"
      chmod 600 "$ENV_FILE"
      info ".env restored (the previous one is in $aside)"
    else
      info "the archive holds a .env; kept the current one (--with-env restores it)"
    fi
  fi
  if [ "$running" -eq 1 ]; then
    bash "$HERE/start.sh" --no-attach --dir "$DIR" --data-dir "$DATA"
  else
    info "start the station with: bash $HERE/start.sh"
  fi
  exit 0
fi

# ---- backup ------------------------------------------------------------------------------------------
if [ -z "$DEST" ]; then
  shared="$HOME/storage/shared"
  [ -d "$shared" ] || die "$shared is missing: Termux has no access to shared storage yet." \
    "Run termux-setup-storage once and allow the permission, or pass --dest DIR."
  DEST="$shared/aprscaching-backups"
fi
[ -f "$DB" ] || die "no database at $DB (DB_PATH in $ENV_FILE); start the gateway once first."
mkdir -p "$DEST"
[ -w "$DEST" ] || die "cannot write to $DEST."

NAME="aprscaching-pocket-$TS"
mkdir -p "$DATA"
STAGE="$(mktemp -d "$DATA/backup.XXXXXX")"
chmod 700 "$STAGE"
OUT="$STAGE/$NAME"
mkdir -p "$OUT"

step "Snapshot of $DB"
tables="$(node_sqlite "$SNAPSHOT_JS" "$DB" "$OUT/aprscaching.db")" || die "the snapshot failed."
info "$tables tables, check ok"
included="database"

if [ "$WITH_SECRETS" -eq 1 ]; then
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$OUT/env"
    included="$included, .env"
  fi
  for f in "$DB_DIR"/*.secret; do
    [ -e "$f" ] || continue
    cp "$f" "$OUT/"
    included="$included, $(basename "$f")"
  done
fi

if [ -d "$MEDIA" ] && [ "$MEDIA_MODE" != no ]; then
  media_kb="$(du -sk "$MEDIA" | cut -f1)"
  if [ "$MEDIA_MODE" = yes ] || [ "$media_kb" -le $((MEDIA_MAX_MB * 1024)) ]; then
    cp -R "$MEDIA" "$OUT/media"
    included="$included, media"
  else
    info "media left out: $((media_kb / 1024)) MiB is over ${MEDIA_MAX_MB} MiB (--media includes it)"
  fi
fi

{
  printf 'aprscaching Pocket backup\n'
  printf 'created: %s\n' "$TS"
  printf 'commit: %s\n' "$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'database: %s (%s tables)\n' "$DB" "$tables"
  printf 'contains: %s\n' "$included"
} >"$OUT/MANIFEST"

step "Writing $DEST/$NAME.tar.gz"
tar -czf "$STAGE/$NAME.tar.gz" -C "$STAGE" "$NAME"
# Copy under a temporary name first, so an interrupted copy never looks like a finished archive.
cp "$STAGE/$NAME.tar.gz" "$DEST/.$NAME.tar.gz.partial"
mv "$DEST/.$NAME.tar.gz.partial" "$DEST/$NAME.tar.gz"
info "$(du -h "$DEST/$NAME.tar.gz" | cut -f1): $included"

if [ "$WITH_SECRETS" -eq 1 ]; then
  real_dest="$(cd "$DEST" && pwd -P)"
  case "$real_dest" in
    /storage/* | /sdcard* | /mnt/*)
      warn "the archive holds the instance secrets (.env, session.secret) and lies on shared storage, which" \
        "any app with storage permission can read. Move it somewhere private, or use --no-env." ;;
  esac
fi

# Keep the newest $KEEP archives (the names sort by time).
mapfile -t old < <(find "$DEST" -maxdepth 1 -type f -name 'aprscaching-pocket-*.tar.gz' | sort | head -n "-$KEEP")
for f in "${old[@]}"; do
  rm -f "$f"
  info "removed the older $(basename "$f")"
done
