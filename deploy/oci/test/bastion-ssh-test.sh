#!/usr/bin/env bash
# Checks of deploy/oci/bastion-ssh.sh with the OCI CLI and ssh mocked on PATH: the first login creates a
# Bastion session and waits for it, the next reuses it; managed sessions, ProxyCommand mode, the ssh_config
# block, saved settings, closing, and refusals of bad input.
#
#   bash deploy/oci/test/bastion-ssh-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bastion-ssh.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
check() { # check "name" command…
  local name="$1"
  shift
  if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; FAILED=1; fi
}

BASTION="ocid1.bastion.oc1.eu-frankfurt-1.aaaabastion"
INSTANCE="ocid1.instance.oc1.eu-frankfurt-1.aaaainstance"
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" XDG_CACHE_HOME="$TMP/home/.cache"
mkdir -p "$HOME/.ssh" "$TMP/bin"
: >"$HOME/.ssh/id_ed25519"
: >"$HOME/.ssh/id_ed25519.pub"
LOG="$TMP/calls"

# The OCI CLI: answers what the script asks, and logs each call.
cat >"$TMP/bin/oci" <<'MOCK'
#!/usr/bin/env bash
echo "oci $*" >>"$MOCK_LOG"
case "$*" in
  *"compute instance list-vnics"*) echo "10.0.1.5" ;;
  *"bastion bastion get"*) echo "10800" ;;
  *"bastion session create-port-forwarding"*) echo "ocid1.bastionsession.oc1.eu-frankfurt-1.fwd" ;;
  *"bastion session create-managed-ssh"*) echo "ocid1.bastionsession.oc1.eu-frankfurt-1.mng" ;;
  *"bastion session get"*) echo "ACTIVE" ;;
  *"bastion session delete"*) ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
MOCK
# ssh: records its arguments instead of connecting.
cat >"$TMP/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_SSH"
MOCK
chmod +x "$TMP/bin/oci" "$TMP/bin/ssh"
export PATH="$TMP/bin:$PATH" MOCK_LOG="$LOG" MOCK_SSH="$TMP/ssh"
run() { "$SCRIPT" --bastion-id "$BASTION" --instance-id "$INSTANCE" "$@" 2>"$TMP/err"; }
count() { grep -c -- "$1" "$LOG" || true; }

: >"$LOG"
: >"$TMP/ssh"
check "a first login creates a port-forwarding session" run -- uptime
check "  … looked up the private IP and the bastion's TTL" bash -c "grep -q 'list-vnics' '$LOG' && grep -q 'bastion bastion get' '$LOG'"
check "  … in the bastion's region" grep -q -- "--region eu-frankfurt-1" "$LOG"
check "  … then connected through the bastion host to the VM" \
  grep -q "ProxyCommand=.*ocid1.bastionsession.oc1.eu-frankfurt-1.fwd@host.bastion.eu-frankfurt-1.oci.oraclecloud.com -W %h:%p ubuntu@10.0.1.5 uptime" "$TMP/ssh"
check "a second login reuses the session" bash -c "'$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' 2>/dev/null; [ \"\$(grep -c create-port-forwarding '$LOG')\" = 1 ]"
check "--managed creates a managed SSH session for the instance" bash -c "'$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' --managed 2>/dev/null && grep -q 'create-managed-ssh .*--target-resource-id $INSTANCE' '$LOG'"

: >"$TMP/ssh"
check "--proxy hands ssh a raw connection to the VM's port 22" run --proxy 10.0.1.5 22
check "  … with -W to the private IP" grep -q -- "-W 10.0.1.5:22" "$TMP/ssh"

check "--ssh-config prints a Host block that proxies through the script" \
  bash -c "'$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' --ssh-config 2>/dev/null | grep -q 'ProxyCommand .*bastion-ssh.sh\" --proxy %h %p'"

check "--save keeps the settings, owner-only" bash -c "'$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' --save --ssh-config >/dev/null 2>&1 && [ \"\$(stat -c %a '$XDG_CONFIG_HOME/aprscaching/oci-ssh.env')\" = 600 ]"
check "  … so a later login needs no flags" bash -c "'$SCRIPT' 2>/dev/null"

check "--close deletes the cached sessions" bash -c "'$SCRIPT' --close 2>/dev/null && grep -q 'session delete' '$LOG' && ! ls '$XDG_CACHE_HOME'/aprscaching/bastion-session-* >/dev/null 2>&1"

check "refuses an OCID of the wrong kind" bash -c "! '$SCRIPT' --bastion-id ocid1.instance.oc1.x.y --instance-id '$INSTANCE' 2>/dev/null"
check "refuses a missing key" bash -c "! '$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' --key '$TMP/none' 2>/dev/null"
check "explains a missing OCI CLI" bash -c "PATH=/usr/bin:/bin '$SCRIPT' --bastion-id '$BASTION' --instance-id '$INSTANCE' 2>&1 | grep -q 'OCI CLI'"

if [ "$FAILED" = 0 ]; then echo; echo "all bastion-ssh checks passed"; else echo; echo "bastion-ssh checks FAILED"; exit 1; fi
