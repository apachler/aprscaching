#!/usr/bin/env bash
# Pocket setup wizard: the few choices a station needs after install, asked one at a time in Android
# dialogs (Termux:API's termux-dialog) or, without the Termux:API app, as questions in the terminal.
# Each question shows the current value; an empty answer keeps it. Nothing is written until the summary
# is confirmed, so cancelling at any point changes nothing.
#
#   bash ~/aprscaching/deploy/pocket/wizard.sh
#   bash ~/aprscaching/deploy/pocket/wizard.sh --text      # questions in the terminal, even with Termux:API
#
# It asks for:
#   - your callsign (the base call: ADMIN_CALLSIGNS and APRSIS_CALLSIGN);
#   - the station's instance name (INSTANCE), the name other instances know it by when it federates. It
#     is set once: records carry the name they were made under, so a station that already holds caches
#     or finds keeps its name;
#   - whether to set up a MeshCom node now (meshcom-setup.sh);
#   - home-screen shortcuts and a daily backup while charging (extras/setup.sh).
# Then it restarts a running station and opens Instance admin in the browser, where the Setup checklist
# covers the rest.
#
# Options:
#   --text               ask in the terminal instead of Android dialogs
#   --dry-run            ask, validate and print what would change, without writing or running anything
#   --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
#   --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
#   -h, --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/pocket/lib.sh
. "$HERE/lib.sh"

TEXT=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --text) TEXT=1 ;;
    --dry-run) DRY=1 ;;
    --dir) DIR="${2:-}"; shift ;;
    --data-dir) DATA="${2:-}"; shift ;;
    -h | --help) pocket_usage "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; pocket_usage "$0" >&2; exit 2 ;;
  esac
  shift
done
pocket_paths
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing." "Run deploy/pocket/install.sh first; it writes that file."

# Dialogs when the Termux:API app answers; the terminal otherwise.
UI=text
if [ "$TEXT" -eq 0 ] && have termux-dialog && termux_api_ready; then UI=dialog; fi

cancelled() {
  info "cancelled; nothing changed"
  exit 1
}

# One field of termux-dialog's JSON answer.
dialog_field() { json_field "$1"; }

# ask TITLE CURRENT [HINT] → the answer on stdout, CURRENT when left empty. A dialog waits for the person,
# so it runs without termux_api's time limit.
ask() {
  local title="$1" current="$2" hint="${3:-}" out code answer
  if [ "$UI" = dialog ]; then
    out="$(termux-dialog text -t "$title" -i "${current:-$hint}" 2>/dev/null)" || cancelled
    code="$(printf '%s' "$out" | dialog_field code)"
    [ "$code" = "-1" ] || cancelled
    answer="$(printf '%s' "$out" | dialog_field text)"
  else
    printf '    %s%s: ' "$title" "${current:+ [$current]}" >&2
    IFS= read -r answer || cancelled
  fi
  answer="$(printf '%s' "$answer" | tr -d '[:space:]')"
  printf '%s' "${answer:-$current}"
}

# confirm TITLE DEFAULT(yes|no) → status 0 for yes.
confirm() {
  local title="$1" default="$2" out answer
  if [ "$UI" = dialog ]; then
    out="$(termux-dialog confirm -t "$title" -i "Yes or no" 2>/dev/null)" || cancelled
    answer="$(printf '%s' "$out" | dialog_field text)"
    [ -n "$answer" ] || cancelled
  else
    local shown="y/N"
    [ "$default" = yes ] && shown="Y/n"
    printf '    %s [%s]: ' "$title" "$shown" >&2
    IFS= read -r answer || cancelled
    answer="${answer:-$default}"
  fi
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
    y | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# A base callsign: 3–7 letters and digits with at least one digit, no SSID.
valid_call() { printf '%s' "$1" | grep -Eq '^[A-Z0-9]{3,7}$' && printf '%s' "$1" | grep -q '[0-9]'; }

# An instance name: lowercase hostname labels (letters, digits, inner hyphens; 1–63 each, 253 in all),
# never localhost, the name every phone's browser uses for itself.
valid_instance() {
  local name="$1" label
  [ -n "$name" ] && [ "${#name}" -le 253 ] && [ "$name" != localhost ] || return 1
  IFS=. read -r -a labels <<<"$name"
  [ "${name: -1}" != . ] || return 1
  for label in "${labels[@]}"; do
    printf '%s' "$label" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || return 1
  done
}

# Whether the database already holds caches or finds: those carry the instance name they were made under.
db_has_records() {
  local db
  db="$(env_get DB_PATH)"
  [ -n "$db" ] && [ -f "$db" ] || return 1
  local n
  # shellcheck disable=SC2016 # JavaScript template literal, not shell
  n="$(cd "$DIR/servers/node" 2>/dev/null && DB="$db" node -e '
    const D = require("better-sqlite3");
    const db = new D(process.env.DB, { readonly: true, fileMustExist: true });
    let n = 0;
    for (const t of ["caches", "finds"]) { try { n += db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n; } catch {} }
    process.stdout.write(String(n));' 2>/dev/null)" || return 1
  [ "${n:-0}" -gt 0 ]
}

if [ "$UI" = dialog ]; then
  step "Pocket setup: answer in the Android dialogs"
else
  step "Pocket setup: an empty answer keeps the value in brackets"
fi

# ---- callsign ----------------------------------------------------------------------------------------
CUR_CALL="$(env_get ADMIN_CALLSIGNS | cut -d, -f1 | tr -d '[:space:]')"
[ "$CUR_CALL" != N0CALL ] || CUR_CALL=""
while :; do
  CALL="$(ask "Your callsign (base call, no SSID)" "$CUR_CALL" "OE8APR" | tr '[:lower:]' '[:upper:]')"
  if valid_call "$CALL"; then break; fi
  warn "'$CALL' is not a base callsign: 3-7 letters and digits with a digit, no SSID (e.g. OE8APR)"
  [ "$UI" = text ] || [ -n "$CALL" ] || cancelled
done

# ---- instance name -----------------------------------------------------------------------------------
CUR_INST="$(env_get INSTANCE)"
INST="$CUR_INST"
if [ -n "$CUR_INST" ]; then
  info "instance name: $CUR_INST (set once; records carry it)"
elif db_has_records; then
  info "instance name: localhost (the station holds caches or finds made under it, so it stays)"
else
  suggested="$(printf '%s' "$CALL" | tr '[:upper:]' '[:lower:]')-pocket"
  while :; do
    INST="$(ask "Instance name (how other instances know this station)" "$suggested")"
    INST="$(printf '%s' "$INST" | tr '[:upper:]' '[:lower:]')"
    INST="${INST%.}"
    if valid_instance "$INST"; then break; fi
    warn "'$INST' is not an instance name: lowercase letters, digits, hyphens and dots, like oe8apr-pocket"
  done
fi

# ---- optional parts ----------------------------------------------------------------------------------
MESHCOM=0
if [ -n "$(env_get MESHCOM_NODE)" ]; then
  confirm "A MeshCom node is set up ($(env_get MESHCOM_NODE)). Set it up again?" no && MESHCOM=1
else
  confirm "Set up a MeshCom node now?" no && MESHCOM=1
fi
SHORTCUTS=0
if [ -d "$HOME/.shortcuts" ] && ls "$HOME/.shortcuts"/aprscaching* >/dev/null 2>&1; then
  info "home-screen shortcuts: installed"
else
  confirm "Home-screen shortcuts (needs the Termux:Widget app)?" yes && SHORTCUTS=1
fi
BACKUP=0
if [ -f "$RUN_DIR/scheduled-backup-job.sh" ]; then
  info "daily backup while charging: registered"
else
  confirm "A daily backup while the phone charges (needs the Termux:API app)?" yes && BACKUP=1
fi

# ---- summary -----------------------------------------------------------------------------------------
step "Summary"
changes=()
if [ "$CALL" != "$(env_get ADMIN_CALLSIGNS | cut -d, -f1 | tr -d '[:space:]')" ]; then changes+=("callsign $CALL"); fi
if [ "$INST" != "$CUR_INST" ]; then changes+=("instance name $INST"); fi
[ "$MESHCOM" -eq 0 ] || changes+=("MeshCom node setup")
[ "$SHORTCUTS" -eq 0 ] || changes+=("home-screen shortcuts")
[ "$BACKUP" -eq 0 ] || changes+=("daily backup while charging")
if [ "${#changes[@]}" -eq 0 ]; then
  info "nothing to change"
else
  for c in "${changes[@]}"; do info "- $c"; done
  confirm "Apply these changes?" yes || cancelled
fi

run() {
  if [ "$DRY" -eq 1 ]; then info "[dry-run] $*"; else "$@"; fi
}
set_value() {
  if [ "$DRY" -eq 1 ]; then info "[dry-run] $1=$2"; else env_set "$1" "$2"; fi
}

restart=0
if [ "$CALL" != "$(env_get ADMIN_CALLSIGNS | cut -d, -f1 | tr -d '[:space:]')" ]; then
  # Further admin calls after the first stay as they are.
  rest="$(env_get ADMIN_CALLSIGNS | cut -s -d, -f2-)"
  set_value ADMIN_CALLSIGNS "$CALL${rest:+,$rest}"
  set_value APRSIS_CALLSIGN "$CALL"
  restart=1
fi
if [ "$INST" != "$CUR_INST" ]; then
  set_value INSTANCE "$INST"
  restart=1
fi
common=(--dir "$DIR" --data-dir "$DATA")
if [ "$MESHCOM" -eq 1 ]; then
  step "MeshCom node"
  run bash "$HERE/meshcom-setup.sh" "${common[@]}" || warn "meshcom-setup.sh ended early; run it again later"
fi
extras=()
[ "$SHORTCUTS" -eq 0 ] || extras+=(--shortcuts)
[ "$BACKUP" -eq 0 ] || extras+=(--scheduled-backup)
if [ "${#extras[@]}" -gt 0 ]; then
  run bash "$HERE/extras/setup.sh" "${extras[@]}" "${common[@]}" || warn "extras/setup.sh ended early"
fi
if [ "$restart" -eq 1 ] && session_exists; then
  step "Restarting the station"
  if [ "$DRY" -eq 1 ]; then info "[dry-run] restart the station"; else restart_station || true; fi
fi

# ---- hand over ---------------------------------------------------------------------------------------
URL="http://localhost:$(gateway_port)/?view=admin"
step "Next: Instance admin"
info "Sign in, then open Admin → Setup for the rest of the checklist: $URL"
info "No passkey on this phone? bash $HERE/signin-link.sh $CALL"
if [ "$DRY" -eq 0 ] && have termux-open-url; then termux-open-url "$URL" 2>/dev/null || true; fi
