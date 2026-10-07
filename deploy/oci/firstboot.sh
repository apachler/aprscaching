#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# First boot of the OCI stack's VM, run as root by cloud-init: installs Docker from Docker's signed apt
# repository, checks out the code the stack names, writes deploy/.env through `deploy/aprscaching init
# selfhost`, starts the stack and runs `doctor`. Everything it prints goes to /var/log/aprscaching-firstboot.log
# and to the serial console, so the console connection shows how the boot went without SSH.
#
# The stack's settings arrive in /etc/aprscaching/firstboot.env (KEY=VALUE lines, owner-only). It is read line
# by line, never sourced, so a value cannot run as shell. Running it again keeps what is there: an existing
# checkout stays at its commit (updates go through `deploy/aprscaching update`), an existing deploy/.env keeps
# its values and secrets, and the data lives in Docker volumes, which nothing here removes.
#
# Every path is overridable from the environment, for deploy/oci/test/firstboot-test.sh.
set -euo pipefail

SETTINGS="${APRS_FB_SETTINGS:-/etc/aprscaching/firstboot.env}"
LOG="${APRS_FB_LOG:-/var/log/aprscaching-firstboot.log}"
CONSOLE="${APRS_FB_CONSOLE:-/dev/console}"
DIR="${APRS_FB_DIR:-/opt/aprscaching}"
KEYRING="${APRS_FB_KEYRING:-/etc/apt/keyrings/docker.gpg}"
APT_LIST="${APRS_FB_APT_LIST:-/etc/apt/sources.list.d/docker.list}"
CLOUD_DIR="${APRS_FB_CLOUD_DIR:-/var/lib/cloud}"
UNIT_DIR="${APRS_FB_UNIT_DIR:-/etc/systemd/system}"
HEALTH_WAIT_S="${APRS_FB_HEALTH_WAIT_S:-1200}"
OCI_VENV="${APRS_FB_OCI_VENV:-/opt/oci-cli}"
OCI_BIN="${APRS_FB_OCI_BIN:-/usr/local/bin/oci}"
IMDS="${APRS_FB_IMDS:-http://169.254.169.254/opc/v2}"
IP_WAIT_S="${APRS_FB_IP_WAIT_S:-600}"

# Docker's release signing key. apt trusts the downloaded key only when its fingerprint is this one, so a
# tampered download or mirror cannot slip in packages.
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

mkdir -p "$(dirname "$LOG")"
touch "$LOG" && chmod 600 "$LOG"
if [ -w "$CONSOLE" ] 2>/dev/null; then
  exec > >(tee -a "$LOG" >"$CONSOLE") 2>&1
else
  exec >>"$LOG" 2>&1
fi

say() { printf 'aprscaching-firstboot: %s\n' "$*"; }
stop() {
  say "STOPPED: $1"
  shift
  for line in "$@"; do say "  $line"; done
  exit 1
}

# ---- settings --------------------------------------------------------------------------------------------
CALL="" PASSCODE="" FILTER="" DOMAIN=":80" REPO_URL="" REPO_REF="" PINNED_COMMIT="" BUCKET=""
ENV_FILE="$DIR/deploy/.env"
if [ ! -f "$SETTINGS" ]; then
  # a first boot that finished removed them; what it set up is all a re-run needs
  [ -d "$DIR/.git" ] && [ -f "$ENV_FILE" ] ||
    stop "no settings at $SETTINGS" "The stack writes them through cloud-init; re-create the instance from the stack."
  SETTINGS=/dev/null
fi
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}" value="${line#*=}"
  case "$key" in
    CALL) CALL="$value" ;;
    PASSCODE) PASSCODE="$value" ;;
    FILTER) FILTER="$value" ;;
    DOMAIN) DOMAIN="${value:-:80}" ;;
    REPO_URL) REPO_URL="$value" ;;
    REPO_REF) REPO_REF="$value" ;;
    PINNED_COMMIT) PINNED_COMMIT="$value" ;;
    BUCKET) BUCKET="$value" ;;
  esac
done <"$SETTINGS"
if [ "$SETTINGS" != /dev/null ]; then
  [ -n "$CALL" ] || stop "the stack named no callsign"
  [ -n "$REPO_URL" ] && [ -n "$REPO_REF" ] || stop "the stack named no repository or ref"
  say "starting: $REPO_URL at $REPO_REF, for $CALL"
else
  say "starting again with the existing checkout and settings"
fi

# ---- Docker, from Docker's signed apt repository ------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "Docker is installed; kept"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  # wireguard-tools and nftables serve deploy/aprscaching net44 (a 44Net Connect tunnel), if the operator adds one
  apt-get install -y -q ca-certificates curl gnupg git wireguard-tools nftables
  tmp="$(mktemp -d)"
  curl -fsSL --retry 5 -o "$tmp/docker.asc" https://download.docker.com/linux/ubuntu/gpg ||
    stop "could not download Docker's signing key"
  # exactly one primary key, and it is Docker's
  fprs="$(gpg --batch --show-keys --with-colons "$tmp/docker.asc" | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}')"
  [ "$fprs" = "$DOCKER_KEY_FPR" ] ||
    stop "Docker's signing key does not have the expected fingerprint" "expected $DOCKER_KEY_FPR" "got ${fprs:-none}"
  mkdir -p "$(dirname "$KEYRING")"
  gpg --batch --yes --dearmor -o "$KEYRING" "$tmp/docker.asc"
  chmod 644 "$KEYRING"
  rm -rf "$tmp"
  codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$KEYRING" "$codename" >"$APT_LIST"
  apt-get update -q
  apt-get install -y -q "${DOCKER_PACKAGES[@]}"
  systemctl enable --now docker
  say "Docker installed from download.docker.com (key $DOCKER_KEY_FPR)"
fi
command -v git >/dev/null 2>&1 || apt-get install -y -q git

# ---- the code ------------------------------------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "kept the existing checkout at $(git -C "$DIR" rev-parse HEAD); update it with deploy/aprscaching update"
else
  git clone --quiet --depth 1 --branch "$REPO_REF" "$REPO_URL" "$DIR" || stop "could not clone $REPO_REF from $REPO_URL"
  head="$(git -C "$DIR" rev-parse HEAD)"
  if [ -n "$PINNED_COMMIT" ]; then
    # A release stack names its tag's commit: a tag moved after the release was built does not deploy.
    if [ "$head" != "$PINNED_COMMIT" ]; then
      rm -rf "$DIR"
      stop "$REPO_REF is at $head, but this stack was built for $PINNED_COMMIT" \
        "The tag no longer names the released code. Nothing was installed."
    fi
    say "verified: $REPO_REF is $head, the commit this stack was released for"
  else
    say "UNVERIFIED: $REPO_REF ($head) is not the release this stack was built for, so no commit pins it"
  fi
fi

# ---- the OCI CLI, for the backups ---------------------------------------------------------------------------
# Every package pinned by hash (deploy/oci/oci-cli-requirements.txt), wheels only. The `oci` on PATH signs in as
# this VM (instance principal), which the stack's policy lets write to its bucket and read its own VNIC.
if [ -n "$BUCKET" ]; then
  if [ ! -x "$OCI_VENV/bin/oci" ]; then
    apt-get install -y -q python3-venv
    if python3 -m venv "$OCI_VENV" &&
      "$OCI_VENV/bin/pip" install --quiet --require-hashes --no-deps --only-binary :all: \
        -r "$DIR/deploy/oci/oci-cli-requirements.txt"; then
      say "installed the OCI CLI from hash-pinned wheels"
    else
      rm -rf "$OCI_VENV"
      say "WARNING: the OCI CLI did not install, so there are no backups to the bucket $BUCKET" \
        "Re-run $0 once the cause is fixed."
      BUCKET=""
    fi
  fi
  if [ -n "$BUCKET" ]; then
    printf '#!/bin/sh\nexport OCI_CLI_AUTH="${OCI_CLI_AUTH:-instance_principal}"\nexec %s/bin/oci "$@"\n' "$OCI_VENV" >"$OCI_BIN"
    chmod 755 "$OCI_BIN"
  fi
fi

# The public address of this VM, through the OCI API (the guest only sees its private one). A reserved IP is
# attached after the VM starts, and the policy may take a while, so it asks for a while.
public_ip() {
  local vnics vnic ip waited=0
  # the metadata is data: fetched into a variable, then parsed, never piped from the fetch into an interpreter
  vnics="$(curl -fsS -H 'Authorization: Bearer Oracle' "$IMDS/vnics/" 2>/dev/null)" || return 1
  vnic="$(printf '%s' "$vnics" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["vnicId"])' 2>/dev/null)" || return 1
  while [ "$waited" -lt "$IP_WAIT_S" ]; do
    ip="$("$OCI_BIN" network vnic get --vnic-id "$vnic" --query 'data."public-ip"' --raw-output 2>/dev/null || true)"
    case "$ip" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s' "$ip"; return 0 ;; esac
    sleep 10
    waited=$((waited + 10))
  done
  return 1
}

# ---- settings file -------------------------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  say "kept the existing $ENV_FILE and its secrets"
else
  args=(--non-interactive --call "$CALL" --no-tunnel --no-network --no-next-steps)
  [ -z "$PASSCODE" ] || args+=(--passcode "$PASSCODE")
  [ -z "$FILTER" ] || args+=(--filter "$FILTER")
  if [ "$DOMAIN" != ":80" ]; then
    args+=(--domain "$DOMAIN")
  else
    # OCI maps the public address outside the guest: ask the API for it, else start on the private one
    if [ -n "$BUCKET" ] && host="$(public_ip)"; then
      say "no hostname given; serving plain http on the public address $host"
    else
      host="$(hostname -I 2>/dev/null | awk '{print $1}')"
      say "NOTE: no hostname given; APP_URL is http://${host:-localhost} until you set the public address" \
        "(APP_URL in $ENV_FILE). A hostname with TLS is the recommended setup."
    fi
    args+=(--lan-host "${host:-localhost}")
  fi
  "$DIR/deploy/aprscaching" init selfhost "${args[@]}" || stop "deploy/aprscaching init selfhost failed"
  grep -q '^SOURCE_REPO=' "$ENV_FILE" || printf 'SOURCE_REPO=%s\n' "$REPO_URL" >>"$ENV_FILE"
  [ -z "$BUCKET" ] || grep -q '^OCI_BUCKET=' "$ENV_FILE" || printf 'OCI_BUCKET=%s\n' "$BUCKET" >>"$ENV_FILE"
  # the bucket keeps the history, so the VM's own disk keeps only the newest three archives
  [ -z "$BUCKET" ] || grep -q '^BACKUP_KEEP=' "$ENV_FILE" || printf 'BACKUP_KEEP=3\n' >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE (INGEST_SECRET and OPERATOR_SECRET generated here)"
fi

# ---- the stack ----------------------------------------------------------------------------------------------
cd "$DIR/deploy"
say "building and starting the stack; the first build takes several minutes"
SOURCE_COMMIT="$(git -C "$DIR" rev-parse HEAD)" docker compose up -d --build || stop "docker compose up failed"

waited=0
until [ "$(docker compose ps gateway --format '{{.Health}}' 2>/dev/null)" = healthy ]; do
  if [ "$waited" -ge "$HEALTH_WAIT_S" ]; then
    say "the gateway is not healthy after ${HEALTH_WAIT_S}s; doctor follows"
    break
  fi
  sleep 10
  waited=$((waited + 10))
done

# ---- nightly backups -----------------------------------------------------------------------------------------
if [ -n "$BUCKET" ]; then
  cp "$DIR/deploy/oci/aprscaching-backup.service" "$DIR/deploy/oci/aprscaching-backup.timer" "$UNIT_DIR/"
  systemctl daemon-reload
  systemctl enable --now aprscaching-backup.timer
  say "nightly backups to the bucket $BUCKET (systemctl list-timers aprscaching-backup.timer)"
  # the first one now, which proves the bucket, the policy and the upload; a new policy can take a minute
  for attempt in 1 2 3 4 5; do
    if systemctl start aprscaching-backup.service; then
      say "the first backup is in the bucket $BUCKET"
      break
    fi
    [ "$attempt" = 5 ] && say "WARNING: the first backup failed; see journalctl -u aprscaching-backup" && break
    sleep 60
  done
fi

say "doctor:"
"$DIR/deploy/aprscaching" doctor || say "doctor reported problems (above); fix them, then run deploy/aprscaching doctor"

# ---- keep the stack's settings out of the disk -----------------------------------------------------------
# cloud-init keeps the user data (and with it the APRS-IS passcode) under $CLOUD_DIR and writes it again on
# every boot, so a unit removes the copies after each boot. The instance metadata service and the stack's
# Terraform state still hold them; README-stack.md says so.
cat >"$UNIT_DIR/aprscaching-scrub-userdata.service" <<UNIT
[Unit]
Description=Remove cloud-init's copies of the APRScaching stack settings
After=cloud-final.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'rm -f $CLOUD_DIR/instances/*/user-data.txt $CLOUD_DIR/instances/*/user-data.txt.i $CLOUD_DIR/instances/*/obj.pkl'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload || true
systemctl enable aprscaching-scrub-userdata.service || true
if [ "$SETTINGS" != /dev/null ]; then shred -u "$SETTINGS" 2>/dev/null || rm -f "$SETTINGS"; fi
rm -f "$CLOUD_DIR"/instances/*/user-data.txt "$CLOUD_DIR"/instances/*/user-data.txt.i
say "done"
