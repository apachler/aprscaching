# Which deployment shape this checkout serves. `init` records it in deploy/.shape (KEY=value lines:
# shape, and env for the .env the shape uses); every other command reads it, and probes the host when the
# file is missing — an installation set up before the helpers existed. Sourced, never run.
# shellcheck shell=bash

SHAPES="selfhost cloudflare ingest-box baremetal pocket desktop"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHAPE_FILE="${APRSCACHING_SHAPE_FILE:-$DEPLOY_DIR/.shape}"

shape_valid() { case " $SHAPES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# shape_record SHAPE ENV_FILE [KEY=VALUE…]: remember what init set up, and anything else the shape needs
# later (the Cloudflare split records its Worker's and app's URLs).
shape_record() {
  local line
  {
    printf 'shape=%s\nenv=%s\n' "$1" "$2"
    shift 2
    for line in "$@"; do printf '%s\n' "$line"; done
  } >"$SHAPE_FILE"
}

shape_recorded() { [ -f "$SHAPE_FILE" ] && sed -n 's/^shape=//p' "$SHAPE_FILE" | tail -n 1; }
shape_env_file() { [ -f "$SHAPE_FILE" ] && sed -n 's/^env=//p' "$SHAPE_FILE" | tail -n 1; }

is_termux() { case "${PREFIX:-}" in */com.termux/*) return 0 ;; *) return 1 ;; esac; }

# The shape the host looks like, or nothing. A deploy/.env with operator settings is a gateway (Self-host);
# one with only the ingest's link is an ingest-only box.
shape_probe() {
  local env="$DEPLOY_DIR/.env"
  if is_termux || [ -f "${APRSCACHING_DATA:-$HOME/.aprscaching}/.env" ]; then
    echo pocket
  elif [ -f /etc/systemd/system/aprscaching-gateway.service ]; then
    echo baremetal
  elif [ -f "$env" ]; then
    if grep -qE '^(OPERATOR_SECRET|ADMIN_CALLSIGNS|APP_URL)=.' "$env"; then echo selfhost; else echo ingest-box; fi
  elif grep -qE '^database_id = "[0-9a-f-]{36}"' "$DEPLOY_DIR/../workers/gateway/wrangler.toml" 2>/dev/null; then
    echo cloudflare
  fi
}

# The shape to act on: the recorded one, else the probed one.
shape_detect() {
  local s
  s="$(shape_recorded || true)"
  [ -n "$s" ] || s="$(shape_probe)"
  printf '%s' "$s"
}
