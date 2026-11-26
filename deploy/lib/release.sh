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

# The release workflow, the one signer whose provenance counts: it is the workflow that builds the bundle,
# called by release-please for a new release tag. Another workflow of the repository could attest a file too.
REL_SIGNER_WORKFLOW=.github/workflows/release-verify.yml

# Check FILE's signed provenance with gh: an attestation of REPO's release workflow must cover it. Returns 0
# when it does, and 1 with the reason on stderr when not, telling a refusal (no attestation for the file, or
# one by another signer) from a check that could not run (Sigstore or the API unreachable, gh not signed in):
# both stop the caller, but only the first is an answer about the file.
rel_attest() {
  local file="$1" repo="$2" out rc=0
  out="$(gh attestation verify "$file" --repo "$repo" --signer-workflow "$repo/$REL_SIGNER_WORKFLOW" 2>&1)" || rc=$?
  [ "$rc" != 0 ] || return 0
  out="$(printf '%s' "$out" | sed '/^$/d' | tr '\n' ' ')"
  case "$out" in
    *"HTTP 404"* | *"verifying with issuer"*)
      printf "\nERROR: the release bundle's signed provenance does not verify: no attestation by %s covers it.\n" \
        "$repo/$REL_SIGNER_WORKFLOW" >&2
      printf '       gh attestation verify: %s\n' "$out" >&2
      ;;
    *)
      printf "\nERROR: the release bundle's signed provenance could not be checked: gh attestation verify exited %s.\n" "$rc" >&2
      printf '       gh said: %s\n' "${out:-nothing}" >&2
      ;;
  esac
  return 1
}

# A release's git bundle, verified: its checksum in the release's SHA256SUMS, its signed provenance from the
# release workflow, and the tag itself inside it. Prints "<commit> <path>": the commit the bundle's tag names,
# which is what the caller installs, and the bundle, in a directory of its own that the caller removes.
# Returns 1 when the release has no bundle (the caller treats the target as unverified) and 2 when it cannot be
# verified (the caller stops): it runs in a command substitution, where a die would end only the subshell.
rel_verified_bundle() {
  local gh_repo tag="$2" dir base rc=0 commit
  gh_repo="$(rel_github_repo "$1")"
  [ -n "$gh_repo" ] || return 1
  have curl || { printf '\nERROR: curl is needed to download the release for its check.\n' >&2; return 2; }
  dir="$(mktemp -d)"
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
    if ! rel_attest "$dir/aprscaching-$tag.bundle" "$gh_repo"; then
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
  # The tag must be in the bundle under its own name: a verified file is checked only for what it holds.
  if ! git init --quiet --bare "$dir/peel" >&2 ||
    ! git -C "$dir/peel" fetch --quiet "$dir/aprscaching-$tag.bundle" "refs/tags/$tag:refs/tags/$tag" >&2 ||
    ! commit="$(git -C "$dir/peel" rev-parse --verify --quiet "refs/tags/$tag^{commit}")"; then
    printf '\nERROR: the release bundle holds no tag %s.\n' "$tag" >&2
    rm -rf "$dir"
    return 2
  fi
  rm -rf "$dir/peel"
  chmod 644 "$dir/aprscaching-$tag.bundle"
  printf '%s %s' "$commit" "$dir/aprscaching-$tag.bundle"
}

# Say that TARGET (KIND: tag, branch or commit) is unverified and ask QUESTION. --yes does not answer it:
# only --unverified or a person at the terminal does.
rel_confirm_unverified() {
  local target="$1" kind="$2" question="$3"
  warn "$target ($kind) is not verified: only a release's bundle carries a checksum and a signature."
  [ "$REL_ALLOW_UNVERIFIED" = 1 ] && return 0
  APRS_ASSUME_YES=0 confirm "$question"
}
