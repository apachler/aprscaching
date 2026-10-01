# update, the same on every shape that runs from a checkout: show what changes, take a backup, move the
# checkout to the target, bring the instance onto it, and check it with doctor. When a check fails that did
# not fail before the update, roll the code and the database back to the backup — at once while the backup
# is fresh (--rollback-window, default 15 minutes), after asking once it is older, since a database rollback
# loses what was written since.
#
# A shape module supplies shape_git (git in the instance's checkout, as the right user) and
# shape_update_apply (build and restart on what the checkout holds); optionally shape_rollback_db <epoch>
# (a database rollback other than restoring the backup, e.g. D1 Time Travel). Sourced by deploy/aprscaching.
# shellcheck shell=bash

# The ids of the checks doctor fails, one per line (it runs in a subshell, so nothing it sets leaks).
doctor_failures() {
  (APRS_JSON=1 run_doctor 2>/dev/null) | grep -oE '"status":"fail","id":"[^"]+"' | sed 's/.*"id":"//; s/"$//' | sort -u || true
}

# Wait for the gateway to answer after a restart (up to two minutes).
update_wait_ready() {
  local base
  base="$( (shape_doctor_context >/dev/null 2>&1; printf '%s' "$DOC_BASE"))"
  [ -n "$base" ] || return 0
  for _ in $(seq 1 60); do
    if (shape_doctor_context >/dev/null 2>&1; gw_curl -fsS -o /dev/null --max-time 3 "$DOC_BASE/health") 2>/dev/null; then return 0; fi
    sleep 2
  done
  warn "the gateway has not answered for two minutes"
}

# Put the pre-update backup's database back exactly as it was: stopped, rows restored at the backup's
# schema with no migration forward. Settings and secrets are not touched by an update, so they stay.
update_restore_exact() {
  local tmp schema
  bk_tmpdir tmp
  tar -xzf "$1" -C "$tmp"
  schema="$(manifest_get "$tmp" schema)"
  if declare -F shape_stop >/dev/null; then shape_stop; fi
  shape_db_restore "$tmp/rows.sql" "$schema" exact
}

# The commit to update to: --ref, else the newest v* tag, else the tracked branch's remote head.
update_target() {
  local ref="$1" branch t
  if [ -n "$ref" ]; then
    shape_git rev-parse --verify --quiet "origin/$ref^{commit}" 2>/dev/null ||
      shape_git rev-parse --verify --quiet "$ref^{commit}" ||
      die "No commit, tag or branch '$ref' in the repository."
    return
  fi
  t="$(shape_git tag -l 'v*' --sort=-v:refname | head -n 1)"
  if [ -n "$t" ]; then
    shape_git rev-parse "$t^{commit}"
    return
  fi
  branch="$(shape_git rev-parse --abbrev-ref HEAD)"
  [ "$branch" != HEAD ] || die "The checkout is on no branch and the repository has no release tag." "Pass --ref."
  shape_git rev-parse "origin/$branch"
}

run_update() {
  local ref="" window=15 cur target branch before after new t0 age
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) ref="$2"; shift ;;
      --rollback-window) window="$2"; shift ;;
      -h | --help)
        printf '%s\n' "deploy/aprscaching update [--ref REF] [--rollback-window MINUTES]" \
          "Updates to REF (default: the newest release tag, else the branch's head), backing up first and" \
          "rolling back code and database when doctor finds a new failure (automatically within the window)."
        return 0
        ;;
      *) die "Unknown option $1." ;;
    esac
    shift
  done
  [[ "$window" =~ ^[0-9]+$ ]] || die "--rollback-window takes minutes."
  declare -F shape_update_apply >/dev/null || die "'update' is not available for the $SHAPE shape."

  step "Update"
  shape_git fetch --quiet --tags origin || die "Fetching from origin failed."
  [ -z "$(shape_git status --porcelain --untracked-files=no)" ] ||
    die "The checkout has local changes." "Commit or stash them, then update again."
  cur="$(shape_git rev-parse HEAD)"
  branch="$(shape_git rev-parse --abbrev-ref HEAD)"
  target="$(update_target "$ref")"
  if [ "$target" = "$cur" ]; then
    info "already at $(shape_git describe --tags --always "$cur")"
    return 0
  fi
  info "from $(shape_git describe --tags --always "$cur") to $(shape_git describe --tags --always "$target")"
  if shape_git merge-base --is-ancestor "$cur" "$target"; then
    info "changes ($(shape_git rev-list --count "$cur..$target") commits):"
    shape_git log --oneline --no-decorate "$cur..$target" | head -n 15 | while IFS= read -r l; do info "  $l"; done
  else
    warn "the target is not ahead of the running version (a downgrade or another line): migrations never run backward"
  fi
  confirm "Update now?" || die "Nothing was changed." "Pass --yes to update without asking."

  before="$(doctor_failures)"
  BACKUP_LAST=""
  if declare -F shape_db_dump >/dev/null; then
    run_backup
    info "pre-update backup: $BACKUP_LAST"
  fi
  t0="$(date +%s)"

  step "Moving the checkout to $(shape_git describe --tags --always "$target")"
  if [ "$branch" != HEAD ] && [ "$target" = "$(shape_git rev-parse "origin/$branch" 2>/dev/null)" ]; then
    shape_git merge --quiet --ff-only "origin/$branch"
  else
    shape_git -c advice.detachedHead=false checkout --quiet "$target"
  fi
  if shape_update_apply && update_wait_ready; then
    after="$(doctor_failures)"
    new="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed '/^$/d')"
    if [ -z "$new" ]; then
      run_doctor || true
      info "Updated to $(shape_git describe --tags --always "$target").${BACKUP_LAST:+ The pre-update backup stays at $BACKUP_LAST.}"
      return 0
    fi
    warn "after the update these checks fail: $(printf '%s' "$new" | tr '\n' ' ')"
  else
    warn "bringing the instance onto the new version failed"
  fi

  age=$((($(date +%s) - t0) / 60))
  if [ "$age" -gt "$window" ]; then
    warn "the pre-update backup is $age minutes old: rolling the database back loses what was written since"
    if ! confirm "Roll the code and the database back to before the update?"; then
      info "Left as it is. To roll back by hand:"
      info "  git checkout $cur   (in the instance's checkout), then deploy/aprscaching restore $BACKUP_LAST"
      return 1
    fi
  fi
  step "Rolling back to $(shape_git describe --tags --always "$cur")"
  # The database first, with the new version's tools but held at the backup's schema, so the previous code
  # finds the schema it knows; then the code.
  if declare -F shape_rollback_db >/dev/null; then
    shape_rollback_db "$t0"
  elif [ -n "$BACKUP_LAST" ]; then
    update_restore_exact "$BACKUP_LAST"
  fi
  if [ "$branch" != HEAD ]; then shape_git reset --quiet --keep "$cur"; else shape_git checkout --quiet "$cur"; fi
  shape_update_apply || warn "rebuilding the previous version reported an error"
  update_wait_ready
  run_doctor || true
  warn "The update was rolled back. Its failures are listed above; the backup is $BACKUP_LAST."
  return 1
}
