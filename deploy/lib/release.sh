# Release verification, one check for every command that moves a box to new code (init baremetal, update):
# a release tag is trusted only through its git bundle, whose checksum is in the release's SHA256SUMS and
# whose signed provenance `gh attestation verify` accepts. A tag on the remote proves nothing on its own: a
# leaked token or a tag the ruleset lets anyone create looks the same as a release. Anything that cannot be
# verified that way (a branch, a commit, a tag without a bundle, a repository off GitHub) is warned about
# and confirmed explicitly; --yes alone does not pass it, so an unattended run never installs it.
#
#   REL_ALLOW_UNSIGNED=1    (--checksum-only) accept the checksum alone when gh is not installed
#   REL_ALLOW_UNVERIFIED=1  (--unverified) take a target no release verifies without being asked
# Sourced by deploy/aprscaching.
# shellcheck shell=bash

REL_ALLOW_UNSIGNED="${REL_ALLOW_UNSIGNED:-0}"
REL_ALLOW_UNVERIFIED="${REL_ALLOW_UNVERIFIED:-0}"

# The GitHub owner/name of a repository URL (https or ssh), or nothing for another host.
rel_github_repo() {
  printf '%s' "$1" | sed -n -E 's#^(https://github\.com/|ssh://git@github\.com/|git@github\.com:)([^/]+/[^/.]+)(\.git)?/?$#\2#p'
}

# Download URL to FILE. Returns 0, 1 when the server says there is no such file (404), and 2 for every
# other outcome, with what went wrong on stderr: a server error or a network failure is not "no bundle".
rel_download() {
  local url="$1" out="$2" code rc=0
  code="$(curl -sSL -o "$out" -w '%{http_code}' "$url" 2>"$out.err")" || rc=$?
  case "$rc:$code" in
    0:200) rm -f "$out.err"; return 0 ;;
    *:404) rm -f "$out.err"; return 1 ;;
  esac
  printf '\nERROR: downloading %s failed (HTTP %s, curl exit %s): %s\n' "$url" "${code:-none}" "$rc" \
    "$(tr '\n' ' ' <"$out.err")" >&2
  return 2
}

# A release's git bundle, verified: its checksum in the release's SHA256SUMS and its signed provenance.
# Prints the bundle's path, in a directory of its own that the caller removes. Returns 1 when the release
# has no bundle (the caller treats the target as unverified) and 2 when it cannot be verified (the caller
# stops): it runs in a command substitution, where a die would end only the subshell.
rel_verified_bundle() {
  local gh_repo tag="$2" dir base rc=0
  gh_repo="$(rel_github_repo "$1")"
  [ -n "$gh_repo" ] || return 1
  have curl || { printf '\nERROR: curl is needed to download the release for its check.\n' >&2; return 2; }
  dir="$(mktemp -d)"
  chmod 755 "$dir" # a service user fetches from here
  base="https://github.com/$gh_repo/releases/download/$tag"
  rel_download "$base/aprscaching-$tag.bundle" "$dir/aprscaching-$tag.bundle" &&
    rel_download "$base/SHA256SUMS" "$dir/SHA256SUMS" || rc=$?
  if [ "$rc" != 0 ]; then
    rm -rf "$dir"
    return "$rc"
  fi
  if ! (cd "$dir" && grep " aprscaching-$tag.bundle\$" SHA256SUMS | sha256sum -c --quiet -) >&2; then
    printf '\nERROR: the release bundle does not match its checksum.\n' >&2
    rm -rf "$dir"
    return 2
  fi
  if have gh; then
    if ! gh attestation verify "$dir/aprscaching-$tag.bundle" --repo "$gh_repo" >&2; then
      printf "\nERROR: the release bundle's signed provenance does not verify.\n" >&2
      rm -rf "$dir"
      return 2
    fi
  elif [ "$REL_ALLOW_UNSIGNED" != 1 ]; then
    printf '\nERROR: the GitHub CLI (gh) is needed to verify the release signature.\n' >&2
    printf '       Install it (https://cli.github.com), or pass --checksum-only to rely on the checksum alone.\n' >&2
    rm -rf "$dir"
    return 2
  else
    warn "only the checksum was checked (--checksum-only): it proves the file intact, not who made it"
  fi
  chmod 644 "$dir/aprscaching-$tag.bundle"
  printf '%s' "$dir/aprscaching-$tag.bundle"
}

# Say that TARGET (KIND: tag, branch or commit) is unverified and ask QUESTION. --yes does not answer it:
# only --unverified or a person at the terminal does.
rel_confirm_unverified() {
  local target="$1" kind="$2" question="$3"
  warn "$target ($kind) is not verified: only a release's bundle carries a checksum and a signature."
  [ "$REL_ALLOW_UNVERIFIED" = 1 ] && return 0
  APRS_ASSUME_YES=0 confirm "$question"
}
