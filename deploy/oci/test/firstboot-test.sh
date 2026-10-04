#!/usr/bin/env bash
# Checks of deploy/oci/firstboot.sh with apt, gpg, git, docker and systemd mocked on PATH: Docker comes from
# its apt repository only behind the pinned key, a release checkout must be the stamped commit, init gets the
# stack's values (and no passcode when there is none), a second run keeps the checkout and .env, and the
# settings and cloud-init's copies of them are removed without the passcode reaching the log.
#
#   bash deploy/oci/test/firstboot-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../firstboot.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
check() { # check "name" command…
  local name="$1"
  shift
  if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; FAILED=1; fi
}

DOCKER_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
HEAD_SHA=1111111111111111111111111111111111111111
mkdir -p "$TMP/bin"
export MOCK_LOG="$TMP/calls" MOCK_STATE="$TMP/state" MOCK_HEAD="$HEAD_SHA" MOCK_FPR="$DOCKER_FPR"

mock() { # mock NAME BODY
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$MOCK_LOG"\n%s\n' "$1" "$2" >"$TMP/bin/$1"
  chmod +x "$TMP/bin/$1"
}
# apt-get: installing docker-ce makes `docker compose version` succeed from then on
mock apt-get 'case "$*" in *docker-ce*) mkdir -p "$MOCK_STATE" && : >"$MOCK_STATE/docker" ;; esac'
mock curl 'case "$*" in *opc/v2/vnics*) echo "[{\"vnicId\":\"ocid1.vnic.oc1..vm\"}]"; exit 0 ;; esac
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo key >"$2"; shift; }; shift; done'
mock gpg 'case "$*" in
  *--show-keys*) printf "pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESA::::::23::0:\nfpr:::::::::%s:\n" "$MOCK_FPR" ;;
  *--dearmor*) while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo bin >"$2"; shift; }; shift; done ;;
esac'
mock dpkg 'echo arm64'
mock systemctl ':'
mock sleep ':'
mock hostname 'echo 10.0.1.5'
mock shred '[ "$1" = -u ] && rm -f "$2"'
# git: a clone creates the checkout with a deploy/aprscaching that records its arguments
mock git 'case "$*" in
  clone*) for d; do :; done; mkdir -p "$d/.git" "$d/deploy"
    mkdir -p "$d/deploy/oci" && : >"$d/deploy/oci/oci-cli-requirements.txt" && : >"$d/deploy/oci/aprscaching-backup.service" && : >"$d/deploy/oci/aprscaching-backup.timer"
    printf "#!/usr/bin/env bash\necho \"aprscaching \$*\" >>\"\$MOCK_LOG\"\ncase \"\$1\" in init) echo APRSIS_PASSCODE=x >\"\$(dirname \"\$0\")/.env\" ;; esac\n" >"$d/deploy/aprscaching"
    chmod +x "$d/deploy/aprscaching" ;;
  *"rev-parse HEAD"*) echo "$MOCK_HEAD" ;;
esac'
mock docker 'case "$*" in
  "compose version") [ -f "$MOCK_STATE/docker" ] ;;
  *"ps gateway"*) echo healthy ;;
esac'
# python3 -m venv: a venv whose pip and oci are mocks too; anything else is the real python3
REAL_PY="$(command -v python3)"
mock python3 'if [ "$1" = -m ] && [ "$2" = venv ]; then
  mkdir -p "$3/bin"
  printf "#!/usr/bin/env bash\necho \"pip \$*\" >>\"\$MOCK_LOG\"\n[ -z \"\$MOCK_PIP_FAIL\" ]\n" >"$3/bin/pip"
  printf "#!/usr/bin/env bash\necho \"oci[\$OCI_CLI_AUTH] \$*\" >>\"\$MOCK_LOG\"\ncase \"\$*\" in *\"vnic get\"*) echo 203.0.113.7 ;; esac\n" >"$3/bin/oci"
  chmod +x "$3/bin/pip" "$3/bin/oci"
else exec '"$REAL_PY"' "$@"; fi'
export PATH="$TMP/bin:$PATH"

# setup NAME [PINNED_COMMIT] [PASSCODE] [DOMAIN] [BUCKET]: a fresh root for one run
setup() {
  R="$TMP/$1"
  mkdir -p "$R/etc" "$R/cloud/instances/i-1" "$R/units"
  printf 'CALL=OE8APR\nPASSCODE=%s\nFILTER=r/47.07/15.42/300 b/OE8*\nDOMAIN=%s\nREPO_URL=https://github.com/apachler/aprscaching\nREPO_REF=v1.0.0\nPINNED_COMMIT=%s\nBUCKET=%s\n' \
    "${3:-}" "${4:-:80}" "${2:-}" "${5:-}" >"$R/etc/firstboot.env"
  echo "user data with ${3:-nothing}" >"$R/cloud/instances/i-1/user-data.txt"
  : >"$MOCK_LOG"
  rm -rf "$MOCK_STATE"
}
run() {
  APRS_FB_SETTINGS="$R/etc/firstboot.env" APRS_FB_LOG="$R/firstboot.log" APRS_FB_CONSOLE="$R/nonexistent/console" \
    APRS_FB_DIR="$R/opt" APRS_FB_KEYRING="$R/keyrings/docker.gpg" APRS_FB_APT_LIST="$R/docker.list" \
    APRS_FB_CLOUD_DIR="$R/cloud" APRS_FB_UNIT_DIR="$R/units" APRS_FB_OCI_VENV="$R/oci-cli" APRS_FB_OCI_BIN="$R/bin-oci" \
    "$SCRIPT"
}
fails() { ! "$@"; }
logged() { grep -q -- "$1" "$R/firstboot.log"; }
called() { grep -q -- "$1" "$MOCK_LOG"; }

setup release "$HEAD_SHA" 24680
check "a release first boot succeeds" run
check "  … installs Docker from download.docker.com behind the pinned key" \
  bash -c "grep -q 'signed-by=$R/keyrings/docker.gpg\] https://download.docker.com/linux/ubuntu' '$R/docker.list' && grep -q 'apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' '$MOCK_LOG'"
check "  … never pipes a script into a shell" bash -c "! grep -q 'get.docker.com' '$SCRIPT'"
check "  … verifies the checkout against the stamped commit" logged "verified: v1.0.0 is $HEAD_SHA"
check "  … runs init selfhost with the stack's values" \
  called "aprscaching init selfhost --non-interactive --call OE8APR --no-tunnel --no-network --no-next-steps --passcode 24680 --filter r/47.07/15.42/300 b/OE8\* --lan-host 10.0.1.5"
check "  … starts the stack with its commit, then runs doctor" bash -c "grep -q 'docker compose up -d --build' '$MOCK_LOG' && grep -q 'aprscaching doctor' '$MOCK_LOG'"
check "  … records SOURCE_REPO" grep -q '^SOURCE_REPO=https://github.com/apachler/aprscaching$' "$R/opt/deploy/.env"
check "  … removes its settings and cloud-init's copy" bash -c "[ ! -e '$R/etc/firstboot.env' ] && [ ! -e '$R/cloud/instances/i-1/user-data.txt' ]"
check "  … installs the unit that removes the copy after every boot" grep -q "rm -f $R/cloud/instances/\*/user-data.txt" "$R/units/aprscaching-scrub-userdata.service"
check "  … keeps the passcode out of its log" bash -c "! grep -q 24680 '$R/firstboot.log'"
check "  … keeps its log owner-only" bash -c "[ \"\$(stat -c %a '$R/firstboot.log')\" = 600 ]"

: >"$MOCK_LOG"
check "a second run succeeds without the removed settings" run
check "  … keeps the checkout and .env, and does not run init again" \
  bash -c "grep -q 'kept the existing checkout' '$R/firstboot.log' && grep -q 'kept the existing' '$R/firstboot.log' && ! grep -q 'aprscaching init' '$MOCK_LOG'"
check "  … keeps Docker as installed" logged "Docker is installed; kept"

setup nopass "$HEAD_SHA" "" aprs.example.net
check "no passcode: init runs receive-only, with the hostname" run
check "  … and passes no --passcode" bash -c "called() { grep -q -- \"\$1\" '$MOCK_LOG'; }; ! called '--passcode' && called '--domain aprs.example.net'"

check "  … and without a bucket installs no OCI CLI and no backup timer" bash -c "[ ! -e '$R/bin-oci' ] && [ ! -e '$R/units/aprscaching-backup.timer' ]"

setup bucket "$HEAD_SHA" "" ":80" aprscaching-backups-1a2b3c4d
check "with a bucket the first boot succeeds" run
check "  … installs the OCI CLI from hash-pinned wheels only" \
  called "pip install --quiet --require-hashes --no-deps --only-binary :all: -r $R/opt/deploy/oci/oci-cli-requirements.txt"
check "  … whose oci signs in as the instance" bash -c "'$R/bin-oci' os ns get && grep -q '^oci\[instance_principal\] os ns get' '$MOCK_LOG'"
check "  … serves :80 on the public address from the API" called "--lan-host 203.0.113.7"
check "  … sets OCI_BUCKET" grep -qx 'OCI_BUCKET=aprscaching-backups-1a2b3c4d' "$R/opt/deploy/.env"
check "  … and keeps three archives on the VM's disk" grep -qx 'BACKUP_KEEP=3' "$R/opt/deploy/.env"
check "  … installs and starts the nightly timer" bash -c "[ -e '$R/units/aprscaching-backup.timer' ] && grep -q 'systemctl enable --now aprscaching-backup.timer' '$MOCK_LOG'"
check "  … and takes the first backup" bash -c "grep -q 'systemctl start aprscaching-backup.service' '$MOCK_LOG' && grep -q 'the first backup is in the bucket' '$R/firstboot.log'"

setup nocli "$HEAD_SHA" "" ":80" aprscaching-backups-1a2b3c4d
check "an OCI CLI that does not install still brings the instance up" env MOCK_PIP_FAIL=1 bash -c "$(declare -f run); SCRIPT='$SCRIPT' R='$R' run"
check "  … says there are no backups, and sets no timer" bash -c "grep -q 'WARNING: the OCI CLI did not install' '$R/firstboot.log' && [ ! -e '$R/units/aprscaching-backup.timer' ]"
check "  … and falls back to the private address" called "--lan-host 10.0.1.5"

setup branch ""
check "a branch deploys" run
check "  … logged as unverified" logged "UNVERIFIED: v1.0.0"

setup moved 2222222222222222222222222222222222222222
check "a tag that moved off the stamped commit stops the boot" fails run
check "  … removes the checkout and installs nothing" bash -c "[ ! -d '$R/opt' ] && ! grep -q 'aprscaching init' '$MOCK_LOG' && grep -q 'STOPPED: v1.0.0 is at' '$R/firstboot.log'"

setup badkey "$HEAD_SHA"
check "a Docker key with another fingerprint stops the boot" fails env MOCK_FPR=0000000000000000000000000000000000000000 bash -c "$(declare -f run); SCRIPT='$SCRIPT' R='$R' run"
check "  … before apt trusts it" bash -c "[ ! -e '$R/docker.list' ] && [ ! -e '$R/keyrings/docker.gpg' ] && grep -q 'expected fingerprint' '$R/firstboot.log'"

setup nosettings
rm -f "$R/etc/firstboot.env"
check "no settings and no earlier install stops the boot" fails run
check "  … with a reason" logged "STOPPED: no settings"

[ "$FAILED" -eq 0 ] && echo "all firstboot checks passed"
exit "$FAILED"
