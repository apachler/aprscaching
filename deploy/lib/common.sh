# Shared by the deploy helpers (deploy/aprscaching, its shape modules, the Pocket scripts): logging,
# questions, secrets and JSON output. Sourced, never run; the including script sets `set -euo pipefail`.
#
# Output is plain text with no colour or cursor codes, so it reads the same on a terminal, in a log and
# over a serial console. Questions go to the terminal; with APRS_INTERACTIVE=0 (`--non-interactive`) every
# question takes its default and a required answer without one fails with the flag that supplies it.
# shellcheck shell=bash

APRS_INTERACTIVE="${APRS_INTERACTIVE:-1}"
APRS_ASSUME_YES="${APRS_ASSUME_YES:-0}"
APRS_JSON="${APRS_JSON:-0}"

# Progress goes to stderr while --json owns stdout, so the JSON stays parseable.
_out() { if [ "$APRS_JSON" = 1 ]; then cat >&2; else cat; fi; }
step() { printf '\n==> %s\n' "$*" | _out; }
info() { printf '    %s\n' "$*" | _out; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# A terminal to ask on: stdin may be a pipe even when a person is at the keyboard.
can_ask() { [ "$APRS_INTERACTIVE" = 1 ] && { [ -t 0 ] || (: </dev/tty) 2>/dev/null; }; }

_read_tty() { # _read_tty VAR [-s]: one line from the terminal into VAR
  local _line
  if [ -t 0 ]; then IFS= read -r ${2:+"$2"} _line || true; else IFS= read -r ${2:+"$2"} _line </dev/tty || true; fi
  [ "${2:-}" = -s ] && printf '\n' >&2
  printf -v "$1" '%s' "$_line"
}

# ask VAR "question" [default] [flag]: the answer (or the default) in VAR. With a flag, an empty answer
# is refused — interactively the question repeats, non-interactively it fails naming the flag.
ask() {
  local _var="$1" _q="$2" _def="${3:-}" _flag="${4:-}" _ans=""
  while :; do
    if can_ask; then
      printf '%s%s: ' "$_q" "${_def:+ [$_def]}" >&2
      _read_tty _ans
      _ans="${_ans:-$_def}"
    else
      _ans="$_def"
    fi
    if [ -n "$_ans" ] || [ -z "$_flag" ]; then break; fi
    can_ask || die "$_q: no value." "Pass $_flag."
  done
  printf -v "$_var" '%s' "$_ans"
}

# ask_secret VAR "question" [flag]: like ask, without echoing the answer and without a shown default.
ask_secret() {
  local _var="$1" _q="$2" _flag="${3:-}" _ans=""
  if can_ask; then
    printf '%s: ' "$_q" >&2
    _read_tty _ans -s
  fi
  [ -n "$_ans" ] || [ -z "$_flag" ] || die "$_q: no value." "Pass $_flag."
  printf -v "$_var" '%s' "$_ans"
}

# confirm "question": yes with --yes; no when nobody can be asked; else the answer (default no).
confirm() {
  local _ans=""
  [ "$APRS_ASSUME_YES" = 1 ] && return 0
  can_ask || return 1
  printf '%s [y/N] ' "$1" >&2
  _read_tty _ans
  case "$_ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# A fresh random secret: 24 bytes as 48 hex characters.
gen_secret() {
  openssl rand -hex "${1:-24}" 2>/dev/null || head -c "${1:-24}" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# A JSON string literal of $1 (quotes, backslashes and control characters escaped).
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# The usage block of a script: the comment lines after the shebang, up to the first line that is not one.
script_usage() { awk 'NR==1{next} /^#/{sub(/^# ?/, ""); print; next} {exit}' "$1"; }
