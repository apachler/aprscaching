# .env files, edited in place: comments, order and the commented template lines (`# KEY=value`) stay
# where they are, and a file holding secrets stays readable by its owner only. Sourced, never run.
# shellcheck shell=bash

# The active value of KEY in FILE: the last assignment wins, surrounding quotes are stripped, and a
# commented template line does not count. Empty when the file or the key is absent.
env_file_get() {
  [ -f "$1" ] || return 0
  { grep -E "^$2=" "$1" || true; } | tail -n 1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"
}

# The right-hand side of KEY's last assignment in FILE as written, quotes and all: copying a line from one
# .env to another keeps its value intact. Empty when the file or the key is absent.
env_file_raw() {
  [ -f "$1" ] || return 0
  { grep -E "^$2=" "$1" || true; } | tail -n 1 | cut -d= -f2-
}

# env_inert_value RAW: the right-hand side to write for a value as another .env wrote it (env_file_raw), such that
# a shell sourcing the file reads the value and runs nothing: plain when it holds only plain characters, else in
# single quotes. Fails, printing nothing, for a value a shell would expand or that single quotes cannot hold.
# A restored archive's settings go through it, since Pocket's scripts source their .env.
env_inert_value() {
  local raw="$1" v
  case "$raw" in
    \'*\') v="${raw:1:${#raw}-2}" ;;
    \"*\")
      v="${raw:1:${#raw}-2}"
      case "$v" in *[\$\`\\\"]*) return 1 ;; esac
      ;;
    *)
      # as written unquoted, a .env reader other than the shell (Compose, systemd) takes it literally: JSON
      # settings are written so; only an expansion has no literal reading both agree on
      v="$raw"
      case "$v" in *[\$\`]*) return 1 ;; esac
      ;;
  esac
  case "$v" in *\'*) return 1 ;; esac
  case "$v" in
    *[!A-Za-z0-9_./:@,+=%-]*) printf "'%s'" "$v" ;;
    *) printf '%s' "$v" ;;
  esac
}

# Whether FILE assigns KEY (even an empty value).
env_file_has() { [ -f "$1" ] && grep -qE "^$2=" "$1"; }

# The keys FILE assigns, one per line, in file order.
env_file_keys() {
  [ -f "$1" ] || return 0
  sed -n -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$1"
}

# Create FILE owner-only when it is missing, and narrow it to owner-only when it is wider.
env_file_secure() {
  if [ ! -e "$1" ]; then (umask 077 && : >"$1"); fi
  chmod 600 "$1"
}

# Write KEY=VALUE into FILE: replace the active line, else the commented template line, else append.
# The file is rewritten through a temporary copy in the same directory, which never holds wider rights.
env_file_set() {
  local file="$1" key="$2" tmp
  env_file_secure "$file"
  tmp="$(umask 077 && mktemp "$file.XXXXXX")"
  if grep -qE "^$key=" "$file"; then
    K="$key" V="$3" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; d=0}
      index($0, k"=")==1 {if (!d) print k"="v; d=1; next} {print}' "$file" >"$tmp"
  elif grep -qE "^# ?$key=" "$file"; then
    K="$key" V="$3" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; d=0}
      !d && ($0 ~ "^# ?"k"=") {print k"="v; d=1; next} {print}' "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$3" >>"$tmp"
  fi
  mv -f "$tmp" "$file"
}

# Remove every active assignment of KEY from FILE (template lines stay).
env_file_unset() {
  local file="$1" key="$2" tmp
  [ -f "$file" ] || return 0
  tmp="$(umask 077 && mktemp "$file.XXXXXX")"
  K="$key" awk 'BEGIN{k=ENVIRON["K"]} index($0, k"=")!=1 {print}' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# The permission bits of FILE in octal (600, 644, …), on GNU and BSD stat alike.
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
