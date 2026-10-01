# Desktop: the single-file app from a release (deploy/desktop/), which keeps its own data directory and
# generates its secrets on first start. There is nothing to configure before it runs, so init explains where
# to get the binary. Sourced by deploy/aprscaching.
# shellcheck shell=bash
# shellcheck disable=SC2034 # DOC_* is the doctor context, read by deploy/lib/doctor.sh

shape_init() {
  shape_record desktop ""
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":"desktop","docs":"docs/operate/deployment.md#desktop"}\n'
    return 0
  fi
  step "Desktop"
  info "Download the binary for your system from the project's release page and run it;"
  info "it serves the app on http://127.0.0.1:8787."
  info "Steps and options: docs/operate/deployment.md (Desktop) and deploy/desktop/README.md."
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
