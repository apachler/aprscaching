#!/usr/bin/env bash
# Pocket in one command: bring Termux up to date, install aprscaching (install.sh), start the station
# (start.sh) and print the URLs and a one-time sign-in link. Safe to run again: it upgrades, updates the
# checkout, keeps the .env and restarts a running station on the new code.
#
#   curl -fsSLO https://github.com/apachler/aprscaching/releases/latest/download/pocket.sh
#   curl -fsSLO https://github.com/apachler/aprscaching/releases/latest/download/SHA256SUMS
#   sha256sum -c --ignore-missing SHA256SUMS && gh attestation verify pocket.sh --repo apachler/aprscaching
#   bash pocket.sh --call OE8APR
#
# Steps:
#   1. apt-get update && apt-get dist-upgrade: a half-upgraded Termux breaks curl, and pkg with it; apt-get,
#      not pkg, because pkg itself runs curl, and apt-get rather than apt, whose command line is meant for
#      people and warns when a script runs it. When no mirror is chosen, termux-change-repo runs first (with a
#      terminal) or is suggested.
#   2. the code, then install.sh from it with the options below passed on. A release's copy of this script
#      carries the release's tag and the SHA-256 of its git bundle (stamped by release-verify.yml), so once
#      this script is checked, everything it installs is too: it downloads the bundle, compares the hash,
#      and runs the install.sh inside. Without a stamp, or with --branch, it fetches install.sh and the
#      branch from GitHub unchecked, and says so first.
#   3. start.sh --no-attach, then the station's URLs and a one-time sign-in link (the way in where a
#      passkey does not work, e.g. Firefox, or a phone without Google services).
#   4. after a first install, on a terminal, the setup questions (wizard.sh).
#
# bash pocket.sh --help lists the options; any option it does not know goes to install.sh.
# APRSCACHING_RELEASES (default https://github.com/apachler/aprscaching/releases/download) is where a release's
# bundle is fetched from: <APRSCACHING_RELEASES>/<tag>/aprscaching-<tag>.bundle; the stamped hash checks it
# wherever it comes from. APRSCACHING_RAW (default https://raw.githubusercontent.com/apachler/aprscaching) is
# where a branch's install.sh is fetched from: <APRSCACHING_RAW>/<branch>/deploy/pocket/install.sh.
set -euo pipefail

# The release this copy belongs to and the SHA-256 of its git bundle; empty in the repository.
POCKET_RELEASE=""
POCKET_BUNDLE_SHA256=""

# Everything runs from main(), called on the last line: piped into bash, the whole script is read before
# anything runs, so no command can swallow the rest of it from stdin. Commands get stdin from /dev/null,
# and questions go to /dev/tty.

usage() {
  cat <<'EOF'
pocket.sh: install and start aprscaching on an Android phone in Termux, in one command.

  bash pocket.sh --call OE8APR     (downloaded from a release and checked: docs/operate/pocket.md)

Options:
  --call CALL          your callsign (asked on the terminal when a new .env needs it)
  --branch NAME        install a branch instead of this release, unchecked (APRSCACHING_BRANCH;
                       a copy from the repository rather than a release installs main)
  --unverified         install a branch without asking (scripts; the install is not checked)
  --dir PATH           checkout                       (APRSCACHING_DIR, default ~/aprscaching)
  --data-dir PATH      .env, database, logs           (APRSCACHING_DATA, default ~/.aprscaching)
  --gateway-only       start without the ingest (no MeshCom node and no APRS-IS)
  --no-start           install only
  --skip-apt           leave out the apt upgrade
  --allow-non-termux   run outside Termux (a Linux box, to test the steps); implies --skip-apt
  -h, --help
Any other option goes to install.sh (e.g. --port, --repo, --web-dist, --no-update).
EOF
}

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}
# A terminal to ask on, even when stdin is the piped script.
tty_ok() { [ -t 1 ] || [ -t 2 ] || return 1; (: </dev/tty) 2>/dev/null; }
is_termux() { case "${PREFIX:-}" in */com.termux/*) return 0 ;; *) return 1 ;; esac; }

# fetch_release TAG DIR TMP: the release's bundle, checked against the stamped hash, checked out at TAG in
# DIR (cloned when DIR is new). origin stays the repository.
fetch_release() {
  local tag="$1" dir="$2" tmp="$3" rel="${APRSCACHING_RELEASES:-https://github.com/apachler/aprscaching/releases/download}"
  local bundle="$tmp/aprscaching-$tag.bundle" sum
  say "Fetching the $tag release"
  curl -fsSL --retry 3 -o "$bundle" "$rel/$tag/aprscaching-$tag.bundle" </dev/null ||
    fail "cannot download $rel/$tag/aprscaching-$tag.bundle." "Check the connection, then run this again."
  sum="$(sha256sum "$bundle" | cut -d' ' -f1)"
  [ "$sum" = "$POCKET_BUNDLE_SHA256" ] ||
    fail "the $tag bundle does not match the checksum this script carries; nothing was installed." \
      "Download pocket.sh and SHA256SUMS again and check them (docs/operate/pocket.md)."
  note "checked: sha256 $sum"
  if [ -d "$dir/.git" ]; then
    [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] ||
      fail "$dir has local changes; the release was not installed." "Commit or stash them, then run this again."
    git -C "$dir" fetch --quiet "$bundle" "refs/tags/$tag:refs/tags/$tag" </dev/null ||
      fail "the $tag tag in $dir differs from the release's." "Delete it (git -C $dir tag -d $tag), then run this again."
  elif [ -e "$dir" ]; then
    fail "$dir exists but is not a git checkout." "Move it aside or pass --dir PATH."
  else
    git clone --quiet --no-checkout "$bundle" "$dir" </dev/null || fail "cloning the $tag bundle failed."
    git -C "$dir" remote set-url origin https://github.com/apachler/aprscaching.git
  fi
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "refs/tags/$tag" </dev/null ||
    fail "checking out $tag in $dir failed."
}

main() {
  local call="" branch="${APRSCACHING_BRANCH:-}" dir="${APRSCACHING_DIR:-$HOME/aprscaching}" unverified=0
  local data="${APRSCACHING_DATA:-$HOME/.aprscaching}" raw="${APRSCACHING_RAW:-https://raw.githubusercontent.com/apachler/aprscaching}"
  local start=1 apt_step=1 non_termux=0 start_args=() pass=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --call) call="${2:-}"; shift ;;
      --branch) branch="${2:-}"; shift ;;
      --dir) dir="${2:-}"; shift ;;
      --data-dir) data="${2:-}"; shift ;;
      --gateway-only) start_args+=(--gateway-only) ;;
      --no-start) start=0 ;;
      --skip-apt) apt_step=0 ;;
      --unverified) unverified=1 ;;
      --allow-non-termux) non_termux=1; apt_step=0 ;;
      -h | --help) usage; return 0 ;;
      --port | --repo | --web-dist) pass+=("$1" "${2:-}"); shift ;;
      *) pass+=("$1") ;;
    esac
    shift
  done
  case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
  case "$data" in /*) ;; *) data="$PWD/$data" ;; esac

  if ! is_termux && [ "$non_termux" -eq 0 ]; then
    fail "this sets up aprscaching inside Termux on Android." \
      "Install Termux from F-Droid (https://f-droid.org/packages/com.termux/) and run it there."
  fi

  # A release's copy installs that release, checked; a branch is installed only once the operator agrees.
  local release=""
  if [ -n "$POCKET_RELEASE" ] && [ -z "$branch" ]; then
    release="$POCKET_RELEASE"
  else
    branch="${branch:-main}"
    if [ "$unverified" -eq 0 ]; then
      say "Unverified: this installs the $branch branch straight from GitHub, with no checksum or signature"
      tty_ok || fail "an unverified install needs --unverified when there is no terminal to ask on." \
        "Or install a release: docs/operate/pocket.md."
      local answer=""
      printf '    Install it anyway? [y/N] ' >/dev/tty
      IFS= read -r answer </dev/tty || true
      case "$answer" in y* | Y*) ;; *) fail "nothing was installed." ;; esac
    fi
  fi

  # ---- 1. Termux up to date ------------------------------------------------------------------------
  if [ "$apt_step" -eq 1 ]; then
    # pkg reads the chosen mirror (group) from here; without it, pkg and apt use the default mirror.
    local chosen="${PREFIX:-}/etc/termux/chosen_mirrors"
    if [ ! -e "$chosen" ] && [ ! -L "$chosen" ] && command -v termux-change-repo >/dev/null 2>&1; then
      if tty_ok; then
        say "No Termux mirror chosen yet: termux-change-repo (pick a mirror group near you)"
        termux-change-repo </dev/tty >/dev/tty 2>&1 || note "termux-change-repo ended; continuing with the default mirror"
      else
        note "no Termux mirror chosen; if downloads fail, run termux-change-repo and then this again"
      fi
    fi
    say "Upgrading Termux: apt-get update && apt-get dist-upgrade"
    # Non-interactive: keep any config file the operator changed, take the package's default otherwise.
    DEBIAN_FRONTEND=noninteractive apt-get update </dev/null ||
      fail "apt update failed." "Pick another mirror with termux-change-repo, then run this again."
    DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
      -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef </dev/null ||
      fail "apt full-upgrade failed." "Run it by hand (apt full-upgrade), then this again."
  fi

  # ---- 2. install.sh -------------------------------------------------------------------------------
  local first_install=0
  [ -f "$data/.env" ] || first_install=1
  # install.sh asks for the callsign only on a terminal stdin, which a piped run does not have: ask here.
  if [ -z "$call" ] && [ ! -f "$data/.env" ]; then
    if tty_ok; then
      printf '    Your callsign (e.g. OE8APR): ' >/dev/tty
      IFS= read -r call </dev/tty || true
    fi
    [ -n "$call" ] || fail "a callsign is required for the first install: --call <YOURCALL>."
  fi
  local tmp installer
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/aprscaching-pocket.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$tmp'" EXIT
  installer="$tmp/install.sh"
  local args=(--dir "$dir" --data-dir "$data" --no-next-steps)
  if [ -n "$release" ]; then
    # git comes with install.sh's packages, but the bundle needs it first
    if ! command -v git >/dev/null 2>&1; then
      is_termux || fail "git is missing."
      DEBIAN_FRONTEND=noninteractive apt-get install -y git </dev/null || fail "installing git failed."
    fi
    fetch_release "$release" "$dir" "$tmp"
    # a copy, as the checkout is the code it installs; --no-update keeps it at the release
    cp "$dir/deploy/pocket/install.sh" "$installer"
    args+=(--no-update)
  else
    say "Fetching install.sh ($branch)"
    curl -fsSL --retry 3 -o "$installer" "$raw/$branch/deploy/pocket/install.sh" </dev/null ||
      fail "cannot download $raw/$branch/deploy/pocket/install.sh." "Check the branch name and the connection."
    args+=(--branch "$branch")
  fi
  [ -z "$call" ] || args+=(--call "$call")
  [ "$non_termux" -eq 0 ] || args+=(--allow-non-termux)
  bash "$installer" "${args[@]}" "${pass[@]}" </dev/null || fail "install.sh failed; see its output above."

  # ---- 3. start ------------------------------------------------------------------------------------
  # The helpers of the checkout just installed: paths, state, network detection.
  # shellcheck source=deploy/pocket/lib.sh
  . "$dir/deploy/pocket/lib.sh"
  DIR="$dir" DATA="$data"
  pocket_paths
  if [ "$start" -eq 0 ]; then
    note "installed; start the station with: bash $dir/deploy/pocket/start.sh"
    return 0
  fi
  # A station that was already running picks up the new code with a restart.
  if session_exists && restart_station; then
    sleep 3
  fi
  bash "$dir/deploy/pocket/start.sh" --no-attach --dir "$dir" --data-dir "$data" "${start_args[@]}" </dev/null

  local port base name cidr ip kind
  port="$(gateway_port)"
  base="$(gateway_base)"
  say "The station"
  note "on this phone:    http://localhost:$port"
  wifi_detect
  while read -r name cidr; do
    [ -n "${name:-}" ] || continue
    ip="${cidr%%/*}"
    kind="$(kind_of "$name" "$ip")"
    case "$kind" in
      hotspot) note "on the hotspot:   http://$ip:$port   ($name)" ;;
      wlan) note "on Wi-Fi:         http://$ip:$port   ($name: the hotspot, or a network this phone joined)" ;;
      wifi-client) note "on Wi-Fi${WIFI_SSID:+ $WIFI_SSID}: http://$ip:$port   (everyone on that network can reach it)" ;;
      usb-tether | bt-tether | ethernet | vpn) note "on $name:  http://$ip:$port" ;;
    esac
  done < <(list_ipv4)
  note "status:  bash $dir/deploy/pocket/status.sh     stop:  bash $dir/deploy/pocket/stop.sh"

  # A fresh one-time link for the operator's call (the first ADMIN_CALLSIGNS entry when --call was not given).
  [ -n "$call" ] || call="$(env_get ADMIN_CALLSIGNS | cut -d, -f1 | tr -d '[:space:]')"
  if [ -n "$call" ] && health_ok "$base"; then
    say "Sign in: open this link in the browser on this phone (single use, 15 minutes)"
    bash "$dir/deploy/pocket/signin-link.sh" --dir "$dir" --data-dir "$data" "$call" </dev/null ||
      note "no link; mint one later with: bash $dir/deploy/pocket/signin-link.sh $call"
  else
    note "sign in later with: bash $dir/deploy/pocket/signin-link.sh <CALL>"
  fi

  # ---- 4. setup questions --------------------------------------------------------------------------
  # After a first install, on a terminal: the wizard asks the rest (instance name, MeshCom, shortcuts,
  # backup) and opens Instance admin. It can run any time later.
  if [ "$first_install" -eq 1 ] && tty_ok; then
    local answer=""
    printf '\n    Answer a few setup questions now (instance name, MeshCom node, shortcuts, backup, home instance)? [Y/n] ' >/dev/tty
    IFS= read -r answer </dev/tty || true
    case "$answer" in
      n* | N*) note "later: bash $dir/deploy/pocket/wizard.sh" ;;
      *) bash "$dir/deploy/pocket/wizard.sh" --dir "$dir" --data-dir "$data" </dev/tty || true ;;
    esac
  else
    note "setup questions any time: bash $dir/deploy/pocket/wizard.sh"
  fi
}

main "$@"
