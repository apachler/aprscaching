# backup and restore, the same on every shape: one portable archive (aprscaching-<shape>-<UTC>.tar.gz)
# with the database's rows (tools/backup/db.mjs), the settings (.env), the generated secret files beside
# the database, a manifest and, with --with-media, the media. The archive holds secrets: it is created
# owner-only and says so.
#
# A shape module supplies the hooks: shape_db_dump (rows to stdout), shape_db_restore <rows-file> <schema>
# [exact] (builds the new database and keeps the old one aside; with `exact` it stays at the backup's schema), and optionally shape_secrets_dump <dir> /
# shape_secrets_restore <dir>, shape_media_dump <dir> / shape_media_restore <dir>, shape_stop / shape_start
# and shape_settings_restore <file> (where settings do not live in a .env). Sourced by deploy/aprscaching.
# shellcheck shell=bash

BACKUP_FORMAT="aprscaching-backup/1"
MIGRATIONS_DIR_LOCAL="$DEPLOY_DIR/../db/migrations"

# Settings that describe this host rather than the instance: a restore keeps the target's own.
BACKUP_HOST_KEYS=" INGEST_URL DB_PATH PORT MEDIA_DIR MIGRATIONS_DIR WEB_DIST HTTPS_PORT TLS_CERT TLS_KEY TLS_CA_CERT DOMAIN TUNNEL_TOKEN HOST DATA_DIR BOX_ID BOX_KEY TRUST_PROXY TRUST_CF "

# bk_tmpdir VAR: a temporary directory, owner-only, in VAR, removed when the command exits however it exits.
BK_TMPS=()
bk_tmpdir() {
  local d
  d="$(umask 077 && mktemp -d)"
  BK_TMPS+=("$d")
  [ "${#BK_TMPS[@]}" -gt 1 ] || trap 'rm -rf "${BK_TMPS[@]}"' EXIT
  printf -v "$1" '%s' "$d"
}

newest_migration() { find "$MIGRATIONS_DIR_LOCAL" -maxdepth 1 -name '*.sql' -exec basename {} \; | sort | tail -n 1; }

# Rows per table of a rows file, as a JSON object (no Node.js needed).
rows_counts_json() {
  grep -oE '^INSERT INTO "[^"]+"' "$1" | sed 's/^INSERT INTO "//; s/"$//' | sort | uniq -c |
    awk 'BEGIN{printf "{"} {printf "%s\"%s\":%d", (NR>1?",":""), $2, $1} END{printf "}"}'
}

# ---- OCI Object Storage (OCI_BUCKET) -------------------------------------------------------------------------
# Archives go to the bucket under archives/; the bucket's lifecycle rule expires them, so nothing here deletes
# from it and the uploading principal needs no delete right. On the OCI stack's VM, `oci` authenticates as the
# instance (instance principal).
BK_BUCKET_PREFIX="archives/"

bk_bucket() { [ -z "${SHAPE_ENV:-}" ] || env_file_get "$SHAPE_ENV" OCI_BUCKET; }

# bk_upload ARCHIVE: copies ARCHIVE to the bucket when OCI_BUCKET is set; fails when it is set and cannot be.
bk_upload() {
  local bucket name
  bucket="$(bk_bucket)"
  name="$BK_BUCKET_PREFIX$(basename "$1")"
  [ -n "$bucket" ] || return 0
  have oci || die "OCI_BUCKET is set, but the oci CLI is not installed." "The archive stays at $1."
  oci os object put -bn "$bucket" --file "$1" --name "$name" --force >/dev/null ||
    die "The upload to the bucket $bucket failed." "The archive stays at $1."
  info "uploaded: oci://$bucket/$name"
  # the bucket keeps the history; this disk keeps the newest three
  find "$(dirname "$1")" -maxdepth 1 -name "aprscaching-$SHAPE-*.tar.gz" -type f | sort -r | tail -n +4 |
    while IFS= read -r old; do rm -f "$old"; done
}

# The newest archive in the bucket, as an object name; empty when there is none.
bk_bucket_newest() {
  oci os object list -bn "$1" --prefix "$BK_BUCKET_PREFIX" --all \
    --query 'max_by(data, &"time-created").name' --raw-output 2>/dev/null | grep -v '^null$' || true
}

# The newest archive's upload time, as epoch seconds; empty when there is none or the bucket is unreachable.
bk_bucket_newest_time() {
  local t
  t="$(oci os object list -bn "$1" --prefix "$BK_BUCKET_PREFIX" --all \
    --query 'max_by(data, &"time-created")."time-created"' --raw-output 2>/dev/null || true)"
  [ -n "$t" ] && [ "$t" != null ] || return 0
  date -d "$t" +%s 2>/dev/null || true
}

# bk_fetch oci://BUCKET/OBJECT DIR: downloads one archive (OBJECT "latest" is the newest) and prints its path.
bk_fetch() {
  local rest="${1#oci://}" bucket object
  bucket="${rest%%/*}"
  object="${rest#*/}"
  [ -n "$bucket" ] && [ "$object" != "$rest" ] && [ -n "$object" ] ||
    die "A bucket archive is oci://<bucket>/<object>, or oci://<bucket>/latest."
  have oci || die "Restoring from a bucket needs the oci CLI."
  if [ "$object" = latest ]; then
    object="$(bk_bucket_newest "$bucket")"
    [ -n "$object" ] || die "No archive under $BK_BUCKET_PREFIX in the bucket $bucket."
  fi
  info "downloading oci://$bucket/$object" >&2
  oci os object get -bn "$bucket" --name "$object" --file "$2/$(basename "$object")" >/dev/null ||
    die "Downloading oci://$bucket/$object failed."
  chmod 600 "$2/$(basename "$object")"
  printf '%s' "$2/$(basename "$object")"
}

# The newest place backups go: --dest, else BACKUP_DIR, else deploy/backups.
backup_dest_default() {
  local d=""
  [ -z "${SHAPE_ENV:-}" ] || d="$(env_file_get "$SHAPE_ENV" BACKUP_DIR)"
  printf '%s' "${d:-$DEPLOY_DIR/backups}"
}

# backup [--dest DIR] [--with-media] [--no-settings]
run_backup() {
  local dest="" media=0 settings=1 tmp schema name archive secrets=() f
  while [ $# -gt 0 ]; do
    case "$1" in
      --dest) dest="$2"; shift ;;
      --with-media) media=1 ;;
      --no-settings) settings=0 ;;
      -h | --help)
        printf '%s\n' "deploy/aprscaching backup [--dest DIR] [--with-media] [--no-settings]" \
          "One portable archive: the database's rows, the settings, the generated secrets and a manifest;" \
          "--with-media adds the media. It holds secrets and is created readable by its owner only."
        return 0
        ;;
      *) die "Unknown option $1." ;;
    esac
    shift
  done
  declare -F shape_db_dump >/dev/null || die "'backup' is not available for the $SHAPE shape."
  dest="${dest:-$(backup_dest_default)}"
  (umask 077 && mkdir -p "$dest")
  bk_tmpdir tmp

  step "Backup of the $SHAPE instance"
  shape_db_dump >"$tmp/rows.sql" || die "Reading the database failed."
  schema="$(sed -n '1s/^-- aprscaching rows\/1 schema=//p' "$tmp/rows.sql")"
  [ -n "$schema" ] || die "The database dump has no schema line."
  info "database: $(grep -c '^INSERT INTO' "$tmp/rows.sql" || true) rows at $schema"
  if [ "$settings" = 1 ] && [ -n "${SHAPE_ENV:-}" ] && [ -f "$SHAPE_ENV" ]; then
    cp "$SHAPE_ENV" "$tmp/settings.env"
    info "settings: $SHAPE_ENV"
  fi
  mkdir -p "$tmp/secrets"
  if declare -F shape_secrets_dump >/dev/null; then shape_secrets_dump "$tmp/secrets"; fi
  for f in "$tmp"/secrets/*; do [ -e "$f" ] && secrets+=("$(basename "$f")"); done
  [ "${#secrets[@]}" = 0 ] || info "secret files: ${secrets[*]}"
  if [ "$media" = 1 ]; then
    declare -F shape_media_dump >/dev/null || die "--with-media is not available for the $SHAPE shape."
    mkdir -p "$tmp/media"
    shape_media_dump "$tmp/media"
    info "media: $(find "$tmp/media" -type f | wc -l | tr -d ' ') files"
  fi
  {
    printf '{\n  "format": "%s",\n  "createdAt": %s,\n  "shape": %s,\n' "$BACKUP_FORMAT" "$(date +%s)" "$(json_str "$SHAPE")"
    printf '  "schema": %s,\n  "commit": %s,\n' "$(json_str "$schema")" \
      "$(json_str "$(git -C "$DEPLOY_DIR/.." rev-parse HEAD 2>/dev/null || true)")"
    printf '  "sensitive": true,\n  "settings": %s,\n  "media": %s,\n' \
      "$([ -f "$tmp/settings.env" ] && echo true || echo false)" "$([ "$media" = 1 ] && echo true || echo false)"
    printf '  "secrets": [%s],\n' "$(for f in "${secrets[@]+"${secrets[@]}"}"; do printf '%s' "$(json_str "$f"),"; done | sed 's/,$//')"
    printf '  "rows": %s\n}\n' "$(rows_counts_json "$tmp/rows.sql")"
  } >"$tmp/manifest.json"

  name="aprscaching-$SHAPE-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  archive="$dest/$name"
  (umask 077 && tar -czf "$archive" -C "$tmp" .)
  chmod 600 "$archive"
  # shellcheck disable=SC2034 # the pre-update backup, read by update.sh
  BACKUP_LAST="$archive"
  bk_upload "$archive"
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"archive":%s,"schema":%s,"sensitive":true}\n' "$(json_str "$archive")" "$(json_str "$schema")"
  else
    info "archive: $archive"
    info "It holds this instance's secrets: keep it private, and off shared folders."
  fi
}

# The archive's manifest field (a string or a number), without jq.
manifest_get() { sed -n -E "s/^ *\"$2\": *\"?([^\",]*)\"?,?$/\\1/p" "$1/manifest.json" | head -n 1; }

# restore <file | oci://bucket/object | oci://bucket/latest> [--dry-run] [--no-settings]
run_restore() {
  local file="" dry=0 settings=1 tmp fetched schema src newest forward key line
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1 ;;
      --no-settings) settings=0 ;;
      -h | --help)
        printf '%s\n' "deploy/aprscaching restore <archive> [--dry-run] [--no-settings]" \
          "Replaces this instance's data with the archive's; --dry-run shows what would change and changes nothing." \
          "<archive> may be oci://<bucket>/<object>, or oci://<bucket>/latest for the newest one there."
        return 0
        ;;
      -*) die "Unknown option $1." ;;
      *) file="$1" ;;
    esac
    shift
  done
  case "$file" in
    oci://*)
      bk_tmpdir fetched
      file="$(bk_fetch "$file" "$fetched")"
      ;;
  esac
  [ -f "$file" ] || die "No archive at '$file'."
  bk_tmpdir tmp
  tar -xzf "$file" -C "$tmp" 2>/dev/null || die "$file is not a backup archive."
  if [ ! -f "$tmp/manifest.json" ] && [ -f "$tmp/aprscaching.db" ] && declare -F shape_restore_pocket_archive >/dev/null; then
    shape_restore_pocket_archive "$file"
    return
  fi
  [ "$(manifest_get "$tmp" format)" = "$BACKUP_FORMAT" ] || die "$file is not an $BACKUP_FORMAT archive."
  declare -F shape_db_restore >/dev/null || die "'restore' is not available for the $SHAPE shape."
  schema="$(manifest_get "$tmp" schema)"
  src="$(manifest_get "$tmp" shape)"
  newest="$(newest_migration)"
  [ -f "$MIGRATIONS_DIR_LOCAL/$schema" ] ||
    die "The backup's schema ($schema) is newer than this checkout ($newest)." "Update this installation first, then restore."
  forward="$(find "$MIGRATIONS_DIR_LOCAL" -maxdepth 1 -name '*.sql' -exec basename {} \; | sort | awk -v s="$schema" '$0 > s' | tr '\n' ' ')"

  step "Restore of a $src backup into this $SHAPE instance"
  info "taken: $(date -d "@$(manifest_get "$tmp" createdAt)" '+%F %T %Z' 2>/dev/null || manifest_get "$tmp" createdAt)"
  info "database: $(grep -c '^INSERT INTO' "$tmp/rows.sql" || true) rows at $schema${forward:+, then migrated forward: $forward}"
  if [ "$settings" = 1 ] && [ -f "$tmp/settings.env" ]; then
    local keys=()
    while IFS= read -r key; do
      case "$BACKUP_HOST_KEYS" in *" $key "*) continue ;; esac
      cfg_known "$key" && [[ "$(cfg_field "$key" 3)" == *gateway* ]] && keys+=("$key")
    done < <(env_file_keys "$tmp/settings.env")
    info "settings restored: ${keys[*]:-none}"
  fi
  [ -z "$(find "$tmp/secrets" -type f 2>/dev/null)" ] || info "secret files: $(find "$tmp/secrets" -type f -exec basename {} \; | tr '\n' ' ')"
  [ ! -d "$tmp/media" ] || info "media: $(find "$tmp/media" -type f | wc -l | tr -d ' ') files"
  if [ "$src" != "$SHAPE" ]; then
    info "Moving between shapes: keep the same APP_URL (passkeys are bound to its domain), and point the"
    info "ingest box at this instance or enroll it again."
  fi
  if [ "$dry" = 1 ]; then
    info "Dry run: nothing was changed."
    return 0
  fi
  confirm "Replace this instance's data with the backup?" || die "Nothing was restored." "Pass --yes to restore without asking."

  if declare -F shape_stop >/dev/null; then shape_stop; fi
  shape_db_restore "$tmp/rows.sql" "$schema"
  if [ "$settings" = 1 ] && [ -f "$tmp/settings.env" ]; then
    if declare -F shape_settings_restore >/dev/null; then
      shape_settings_restore "$tmp/settings.env"
    elif [ -n "${SHAPE_ENV:-}" ]; then
      env_file_secure "$SHAPE_ENV"
      while IFS= read -r key; do
        case "$BACKUP_HOST_KEYS" in *" $key "*) continue ;; esac
        cfg_known "$key" && [[ "$(cfg_field "$key" 3)" == *gateway* ]] || continue
        line="$(env_file_get "$tmp/settings.env" "$key")"
        env_file_set "$SHAPE_ENV" "$key" "$line"
      done < <(env_file_keys "$tmp/settings.env")
    fi
  fi
  if [ -n "$(find "$tmp/secrets" -type f 2>/dev/null)" ] && declare -F shape_secrets_restore >/dev/null; then
    shape_secrets_restore "$tmp/secrets"
  fi
  if [ -d "$tmp/media" ] && declare -F shape_media_restore >/dev/null; then shape_media_restore "$tmp/media"; fi
  if declare -F shape_start >/dev/null; then shape_start; fi
  info "Restored. The previous database is kept beside the new one (before-restore-*)."
  sleep 3
  run_doctor || true
}
