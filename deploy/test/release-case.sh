#!/usr/bin/env bash
# One case of the release verification, run through one of its two callers with GitHub stubbed: curl serves
# the release files from a fixture directory, gh stands in for the attestation check. Used by helpers-test.sh.
#
#   release-case.sh CALLER MODE WORK FIX [caller options]
#
#   CALLER  init    deploy/aprscaching init baremetal --dry-run (its root and service-user steps print only)
#           update  run_update in a clone of FIX/origin.git, on a shape whose rebuild only leaves a marker
#   MODE    good       the release's files as published
#           tampered   the bundle altered after its checksum was taken
#           missing    the release has no bundle (404)
#           error      the download fails with a server error (500)
#           nogh       gh is not installed
#           moved      the bundle is FIX/rel-moved, a release whose tag is another commit than origin's
#           notag      the bundle is FIX/rel-notag, checksum and attestation in order but holding only v1.0.0
#           unattested gh finds no attestation for the bundle (HTTP 404)
#           otherflow  the bundle's attestation was signed by another workflow of the repository (ci.yml)
#           sigstore   gh cannot reach Sigstore, so the check does not run
#   WORK    an empty directory for this case; WORK/applied appears once the caller goes past its checks
#   FIX     the fixtures: origin.git (a repository with the tags v1.0.0 and v1.1.0), rel (the v1.1.0 release),
#           rel-moved and rel-notag
#
# The caller's exit status is this script's.
set -euo pipefail

CALLER="$1" MODE="$2" WORK="$3" FIX="$4"
shift 4
DEPLOY="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$DEPLOY"
APRS_INTERACTIVE=0
APRS_ASSUME_YES=1 # --yes: what it may pass and what it may not is part of each case
# shellcheck source=deploy/lib/common.sh
. "$DEPLOY/lib/common.sh"
# shellcheck source=deploy/lib/release.sh
. "$DEPLOY/lib/release.sh"

REL="$FIX/rel"
case "$MODE" in moved | notag) REL="$FIX/rel-$MODE" ;; esac
export TMPDIR="$WORK/tmp" # the downloads land here, so a case shows whether it cleaned them up
mkdir -p "$TMPDIR"

curl() {
  local out="" url="" name
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) out="$2"; shift ;;
      -w) shift ;;
      https://*) url="$1" ;;
    esac
    shift
  done
  name="${url##*/}"
  case "$MODE" in
    missing) [ "$name" = SHA256SUMS ] || { printf 404; return 0; } ;;
    error) printf 500; return 0 ;;
  esac
  [ "$url" = "https://github.com/apachler/aprscaching/releases/download/v1.1.0/$name" ] || { printf 404; return 0; }
  cp "$REL/$name" "$out"
  if [ "$MODE" = tampered ] && [ "$name" != SHA256SUMS ]; then echo evil >>"$out"; fi
  printf 200
}
# gh attestation verify FILE --repo R [--signer-workflow W]: like gh, any workflow of R passes unless W pins one
gh() {
  local signer="" by=apachler/aprscaching/.github/workflows/release-verify.yml
  [ "$1 $2" = "attestation verify" ] && [ "$4 $5" = "--repo apachler/aprscaching" ] || return 1
  [ "${6:-}" = --signer-workflow ] && signer="$7"
  case "$MODE" in
    unattested) printf '\nError: HTTP 404: Not Found (https://api.github.com/repos/apachler/aprscaching/attestations/sha256:0)\n' >&2; return 1 ;;
    sigstore) echo "error creating Sigstore verifier: no valid Sigstore verifiers could be initialized" >&2; return 1 ;;
    otherflow) by=apachler/aprscaching/.github/workflows/ci.yml ;;
  esac
  if [ -n "$signer" ] && [ "$signer" != "$by" ]; then printf '\nError: verifying with issuer "sigstore.dev"\n' >&2; return 1; fi
}
have() { if [ "$1" = gh ] && [ "$MODE" = nogh ]; then return 1; fi; command -v "$1" >/dev/null; }

case "$CALLER" in
  init)
    SHAPE_ENV=""
    # shellcheck source=deploy/lib/shapes/baremetal.sh
    . "$DEPLOY/lib/shapes/baremetal.sh"
    bm_preflight() { :; }
    id() { if [ "${1:-}" = -u ]; then echo 1000; else return 1; fi; }
    shape_init --dry-run --dir "$WORK/acs" --user acs --call OE8APR "$@" && rc=0 || rc=$?
    [ "$rc" != 0 ] || touch "$WORK/applied"
    exit "$rc"
    ;;
  update)
    SHAPE=selfhost
    git clone --quiet "$FIX/origin.git" "$WORK/box"
    git -C "$WORK/box" -c advice.detachedHead=false checkout --quiet v1.0.0
    # shellcheck source=deploy/lib/update.sh
    . "$DEPLOY/lib/update.sh"
    # origin is the fixture repository, named as the GitHub repository the release lives in
    shape_git() {
      if [ "$*" = "remote get-url origin" ]; then echo https://github.com/apachler/aprscaching.git; return; fi
      git -C "$WORK/box" "$@"
    }
    shape_update_apply() { git -C "$WORK/box" rev-parse HEAD >"$WORK/applied"; }
    shape_doctor_context() { DOC_BASE=""; }
    run_doctor() { :; }
    run_update "$@"
    ;;
  *) die "Unknown caller $CALLER." ;;
esac
