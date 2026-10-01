# Desktop: the single-file app from a release (deploy/desktop/), which keeps its own data directory and
# generates its secrets on first start. There is nothing to configure before it runs, so init explains where
# to get the binary and how to check it. Sourced by deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

shape_init() {
  shape_record desktop ""
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"desktop","docs":"docs/operate/deployment.md#desktop"}\n'
    return 0
  fi
  step "Desktop"
  info "Download the binary for your system and SHA256SUMS from the project's release page, check them:"
  info "  sha256sum -c --ignore-missing SHA256SUMS"
  info "  gh attestation verify <the binary> --repo apachler/aprscaching"
  info "then run it; it serves the app on http://127.0.0.1:8787."
  info "Steps and options: docs/operate/helpers.md (Verified downloads) and deploy/desktop/README.md."
}

shape_status() {
  local url="http://${HOST:-127.0.0.1}:${PORT:-8787}" health="" ok=0
  if health="$(curl -fsS --max-time 5 "$url/health" 2>/dev/null)"; then ok=1; fi
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"desktop","url":%s,"healthy":%s,"health":%s}\n' \
      "$(json_str "$url")" "$([ "$ok" = 1 ] && echo true || echo false)" "${health:-null}"
    return 0
  fi
  step "Desktop at $url"
  if [ "$ok" = 1 ]; then info "health: $health"; else info "health: the app is not running (no answer from $url/health)"; fi
}

# The desktop app's data directory, as the launcher chooses it.
desktop_data_dir() {
  if [ -n "${DATA_DIR:-}" ]; then echo "$DATA_DIR"
  elif [ "$(uname -s)" = Darwin ]; then echo "$HOME/Library/Application Support/aprscaching"
  else echo "${XDG_DATA_HOME:-$HOME/.local/share}/aprscaching"; fi
}

# doctor: the app on this computer; its secrets are files in its data directory.
shape_doctor_context() {
  local dir
  dir="$(desktop_data_dir)"
  DOC_BASE="http://${HOST:-127.0.0.1}:${PORT:-8787}"
  DOC_INGEST="$DOC_BASE/ingest"
  DOC_DATA_DIR="$dir"
  DOC_DB_FILE="$dir/aprscaching.db"
  [ -n "${OPERATOR_SECRET:-}" ] || OPERATOR_SECRET="$(cat "$dir/operator.secret" 2>/dev/null || true)"
  [ -n "${INGEST_SECRET:-}" ] || INGEST_SECRET="$(cat "$dir/ingest.secret" 2>/dev/null || true)"
}

# Portable backups of the desktop app's data directory, with Node.js and this checkout. The app must be
# closed for a restore: it holds the database open.
dk_need_node() { have node || die "Node.js is needed here to read the desktop app's database." "Or copy its data directory: $(desktop_data_dir)"; }
shape_db_dump() {
  dk_need_node
  node "$DEPLOY_DIR/../tools/backup/db.mjs" dump "$(desktop_data_dir)/aprscaching.db"
}
shape_db_restore() {
  local dir ts f
  dk_need_node
  dir="$(desktop_data_dir)"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rm -f "$dir/restore.db"
  node "$DEPLOY_DIR/../tools/backup/db.mjs" restore "$dir/restore.db" "$DEPLOY_DIR/../db/migrations" "$2" ${3:+--exact} <"$1" >&2
  for f in aprscaching.db aprscaching.db-wal aprscaching.db-shm; do
    if [ -e "$dir/$f" ]; then mv "$dir/$f" "$dir/before-restore-$ts-$f"; fi
  done
  mv "$dir/restore.db" "$dir/aprscaching.db"
}
shape_secrets_dump() { (cd "$(desktop_data_dir)" && for f in *.secret; do if [ -e "$f" ]; then cp -p "$f" "$1/"; fi; done); }
shape_secrets_restore() { cp -p "$1"/*.secret "$(desktop_data_dir)/" && chmod 600 "$(desktop_data_dir)"/*.secret; }
shape_media_dump() { if [ -d "$(desktop_data_dir)/media" ]; then cp -a "$(desktop_data_dir)/media/." "$1/"; fi; }
shape_media_restore() { mkdir -p "$(desktop_data_dir)/media" && cp -a "$1/." "$(desktop_data_dir)/media/"; }
shape_stop() {
  if curl -fsS -o /dev/null --max-time 3 "http://${HOST:-127.0.0.1}:${PORT:-8787}/health" 2>/dev/null; then
    die "The desktop app is running." "Quit it, then restore again."
  fi
}

# The desktop app updates by replacing its binary; its data directory stays.
shape_update() {
  step "Updating the desktop app"
  info "Download the new binary for your system from the project's release page and replace the old one."
  info "Its data directory ($(desktop_data_dir)) stays; the app applies new migrations when it starts."
  info "Take a backup first: deploy/aprscaching backup"
}
