# Desktop: the single-file app from a release (deploy/desktop/), which keeps its own data directory and
# generates its secrets on first start. There is nothing to configure before it runs, so init explains where
# to get the binary. Sourced by deploy/aprscaching.
# shellcheck shell=bash

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
