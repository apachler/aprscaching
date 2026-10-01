# The configuration schema, as the deploy helpers see it: config-keys.tsv beside this file, generated from
# packages/shared/src/config.ts by tools/config/generate.mjs. Sourced, never run.
# shellcheck shell=bash

CONFIG_TSV="${CONFIG_TSV:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config-keys.tsv}"

# One column of KEY's row (1 name, 2 type, 3 units, 4 default, 5 values, 6 secret, 7 publicRequired,
# 8 shapes, 9 hint); empty for an unknown key.
cfg_field() { awk -F'\t' -v k="$1" -v c="$2" '!/^#/ && $1==k {print $c; exit}' "$CONFIG_TSV"; }

cfg_known() { awk -F'\t' -v k="$1" '!/^#/ && $1==k {f=1; exit} END{exit !f}' "$CONFIG_TSV"; }
cfg_secret() { [ "$(cfg_field "$1" 6)" = 1 ]; }
cfg_hint() { cfg_field "$1" 9; }
cfg_default() { cfg_field "$1" 4; }

# The keys that apply to SHAPE, one per line; with a second argument 1, only those a public instance
# must set.
cfg_keys_for() {
  awk -F'\t' -v s="$1" -v req="${2:-0}" '!/^#/ {
    n = split($8, a, ","); for (i = 1; i <= n; i++) if (a[i] == s && (req != 1 || $7 == 1)) {print $1; break}
  }' "$CONFIG_TSV"
}

# cfg_check KEY VALUE: silent and true when VALUE suits KEY's type (a blank value is unset, so it suits);
# otherwise it prints what KEY expects — never the value, which may be a secret in the wrong place.
cfg_check() {
  local key="$1" v="$2" type values
  [ -n "${v//[[:space:]]/}" ] || return 0
  type="$(cfg_field "$key" 2)"
  case "$type" in
    int)
      [[ "$v" =~ ^[[:space:]]*[-+]?[0-9]+[[:space:]]*$ ]] && return 0
      echo "$key: expected a whole number"
      ;;
    number)
      [[ "$v" =~ ^[[:space:]]*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?[[:space:]]*$ ]] && return 0
      echo "$key: expected a number"
      ;;
    enum)
      values="$(cfg_field "$key" 5)"
      case "|$values|" in *"|$v|"*) return 0 ;; esac
      echo "$key: expected one of: ${values//|/, }"
      ;;
    url)
      [[ "$v" =~ ^[[:space:]]*[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+[[:space:]]*$ ]] && return 0
      echo "$key: expected an absolute URL"
      ;;
    json)
      if have node; then
        V="$v" node -e 'JSON.parse(process.env.V)' 2>/dev/null && return 0
      elif have python3; then
        V="$v" python3 -c 'import json, os; json.loads(os.environ["V"])' 2>/dev/null && return 0
      else
        return 0 # nothing here can parse JSON; the gateway checks it at start
      fi
      echo "$key: expected valid JSON"
      ;;
    *) return 0 ;;
  esac
  return 1
}
