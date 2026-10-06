#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# bastion-ssh.sh — log in to the APRScaching OCI VM through OCI Bastion (no public SSH).
#
# The OCI stack leaves port 22 closed to the internet; the only way in is a short-lived Bastion
# session. This script creates (or reuses) that session with the OCI CLI and runs ssh through it, so a
# login is one command:
#
#   deploy/oci/bastion-ssh.sh                      # interactive shell on the VM
#   deploy/oci/bastion-ssh.sh -- sudo docker ps    # run a command
#   deploy/oci/bastion-ssh.sh --managed            # managed SSH session (needs the Bastion agent plugin)
#   deploy/oci/bastion-ssh.sh --ssh-config         # print a Host block, then: ssh / scp / rsync aprscaching-oci
#
# Session types:
#   port forwarding (default)  a tunnel to the VM's private IP, port 22; you log in with the VM's own key.
#                              Needs no agent on the VM, so it still works when the Oracle Cloud Agent is down.
#   managed SSH (--managed)    OCI adds your public key to the VM temporarily; needs the Bastion plugin of
#                              the Oracle Cloud Agent (the stack enables it).
#
# A session lasts at most the bastion's maximum TTL (3 hours by default). The script reuses an ACTIVE
# session for the same target while more than --min-left seconds remain, so repeated logins (and every
# scp/rsync through --proxy) don't create a new one each time. --close deletes the cached session.
#
# Requirements on your machine: the OCI CLI, configured (`oci setup config`, or --auth for another method)
# with an IAM user allowed to use the bastion (policy: "use bastion" + "manage bastion-session" + "read
# instances"/"read vnics" in the compartment), and OpenSSH.
#
# It runs on your own machine, not on the VM, and stands alone (no deploy/lib): in --proxy mode its standard
# output is the SSH connection itself, so everything it says goes to standard error.
#
# Settings come from flags, then environment variables, then ~/.config/aprscaching/oci-ssh.env
# (written by --save). The stack's outputs give the values: bastion_id, instance_id.
#
# Options:
#   --bastion-id OCID     the bastion                                  (OCI_BASTION_ID)
#   --instance-id OCID    the VM                                       (OCI_INSTANCE_ID)
#   --private-ip IP       the VM's private IP (looked up if omitted)   (OCI_PRIVATE_IP)
#   --user NAME           login user on the VM (default ubuntu)        (OCI_SSH_USER)
#   --key PATH            private key; PATH.pub is the public key      (OCI_SSH_KEY, default ~/.ssh/id_ed25519)
#   --profile NAME        OCI CLI profile                              (OCI_CLI_PROFILE)
#   --auth TYPE           OCI CLI auth (api_key, security_token, …)    (OCI_CLI_AUTH)
#   --managed             managed SSH session instead of port forwarding
#   --ttl SECONDS         session lifetime, capped at the bastion's maximum (default 10800)
#   --min-left SECONDS    reuse a cached session only if this much time remains (default 600)
#   --save                remember the settings in ~/.config/aprscaching/oci-ssh.env
#   --ssh-config          print an ssh_config Host block (alias aprscaching-oci) and exit
#   --proxy HOST PORT     ProxyCommand mode, used by that Host block; not for direct use
#   --close               delete the cached session for this target and exit
#   -h, --help
#   -- ARGS…              everything after -- goes to ssh (a remote command, -L forwards, …)
set -euo pipefail

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aprscaching"
CONF_FILE="$CONF_DIR/oci-ssh.env"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/aprscaching"
ALIAS="aprscaching-oci"

die() { printf 'bastion-ssh: %s\n' "$1" >&2; shift; for l in "$@"; do printf '  %s\n' "$l" >&2; done; exit 1; }
info() { printf 'bastion-ssh: %s\n' "$*" >&2; }
usage() { sed -n '4,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

# saved settings first, so environment and flags override them
# shellcheck source=/dev/null
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

BASTION_ID="${OCI_BASTION_ID:-}"
INSTANCE_ID="${OCI_INSTANCE_ID:-}"
PRIVATE_IP="${OCI_PRIVATE_IP:-}"
SSH_USER="${OCI_SSH_USER:-ubuntu}"
KEY="${OCI_SSH_KEY:-$HOME/.ssh/id_ed25519}"
PROFILE="${OCI_CLI_PROFILE:-}"
AUTH="${OCI_CLI_AUTH:-}"
MODE=forward
TTL=10800
MIN_LEFT=600
SAVE=0
ACTION=login
PROXY_HOST="" PROXY_PORT=""
SSH_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bastion-id) BASTION_ID="${2:?}"; shift ;;
    --instance-id) INSTANCE_ID="${2:?}"; shift ;;
    --private-ip) PRIVATE_IP="${2:?}"; shift ;;
    --user) SSH_USER="${2:?}"; shift ;;
    --key) KEY="${2:?}"; shift ;;
    --profile) PROFILE="${2:?}"; shift ;;
    --auth) AUTH="${2:?}"; shift ;;
    --managed) MODE=managed ;;
    --ttl) TTL="${2:?}"; shift ;;
    --min-left) MIN_LEFT="${2:?}"; shift ;;
    --save) SAVE=1 ;;
    --ssh-config) ACTION=sshconfig ;;
    --proxy) ACTION=proxy; PROXY_HOST="${2:?}"; PROXY_PORT="${3:?}"; shift 2 ;;
    --close) ACTION=close ;;
    -h | --help) usage; exit 0 ;;
    --) shift; SSH_ARGS=("$@"); break ;;
    *) die "unknown option '$1'" "deploy/oci/bastion-ssh.sh --help lists the options." ;;
  esac
  shift
done

command -v oci >/dev/null 2>&1 || die "the OCI CLI (oci) isn't installed." \
  "Install it from Oracle's documentation, then run: oci setup config"
command -v ssh >/dev/null 2>&1 || die "ssh isn't installed."
[ -n "$BASTION_ID" ] || die "no bastion given." "Pass --bastion-id (the stack output bastion_id) or set OCI_BASTION_ID."
[ -n "$INSTANCE_ID" ] || die "no instance given." "Pass --instance-id (the stack output instance_id) or set OCI_INSTANCE_ID."
case "$BASTION_ID" in ocid1.bastion.*) ;; *) die "--bastion-id doesn't look like a bastion OCID: $BASTION_ID" ;; esac
case "$INSTANCE_ID" in ocid1.instance.*) ;; *) die "--instance-id doesn't look like an instance OCID: $INSTANCE_ID" ;; esac
case "$TTL$MIN_LEFT" in *[!0-9]*) die "--ttl and --min-left take whole seconds." ;; esac
[ -f "$KEY" ] || die "private key not found: $KEY" "Pass --key PATH (PATH.pub must exist too)."
[ -f "$KEY.pub" ] || die "public key not found: $KEY.pub" "ssh-keygen -y -f $KEY > $KEY.pub creates it."

# The region is the fourth field of an OCID: ocid1.bastion.oc1.eu-frankfurt-1.<unique>
REGION="$(printf '%s' "$BASTION_ID" | cut -d. -f4)"
[ -n "$REGION" ] || die "can't read the region from the bastion OCID."
BASTION_HOST="host.bastion.${REGION}.oci.oraclecloud.com"

OCI=(oci --region "$REGION")
[ -n "$PROFILE" ] && OCI+=(--profile "$PROFILE")
[ -n "$AUTH" ] && OCI+=(--auth "$AUTH")

if [ "$SAVE" -eq 1 ]; then
  mkdir -p "$CONF_DIR"
  umask 077
  {
    printf 'OCI_BASTION_ID=%q\n' "$BASTION_ID"
    printf 'OCI_INSTANCE_ID=%q\n' "$INSTANCE_ID"
    [ -n "$PRIVATE_IP" ] && printf 'OCI_PRIVATE_IP=%q\n' "$PRIVATE_IP"
    printf 'OCI_SSH_USER=%q\n' "$SSH_USER"
    printf 'OCI_SSH_KEY=%q\n' "$KEY"
    [ -n "$PROFILE" ] && printf 'OCI_CLI_PROFILE=%q\n' "$PROFILE"
    [ -n "$AUTH" ] && printf 'OCI_CLI_AUTH=%q\n' "$AUTH"
  } >"$CONF_FILE"
  info "settings saved in $CONF_FILE"
fi

if [ "$ACTION" = sshconfig ]; then
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  cat <<EOF
# Add to ~/.ssh/config, then: ssh $ALIAS   /   scp file $ALIAS:   /   rsync -a dir/ $ALIAS:dir/
# (run "$self --save …" once first, so the ProxyCommand finds the bastion and instance)
Host $ALIAS
    HostName ${PRIVATE_IP:-$ALIAS}
    User $SSH_USER
    IdentityFile $KEY
    IdentitiesOnly yes
    ServerAliveInterval 30
    ProxyCommand "$self" --proxy %h %p
EOF
  exit 0
fi

# The VM's private IP: the session targets it, and ssh connects to it through the bastion. In proxy mode
# ssh passes the HostName as %h; an IPv4 address there is used as is.
if [ "$ACTION" = proxy ] && printf '%s' "$PROXY_HOST" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then PRIVATE_IP="$PROXY_HOST"; fi
if [ -z "$PRIVATE_IP" ]; then
  PRIVATE_IP="$("${OCI[@]}" compute instance list-vnics --instance-id "$INSTANCE_ID" \
    --query 'data[0]."private-ip"' --raw-output 2>/dev/null)" ||
    die "couldn't look up the VM's private IP." "Check the instance OCID, your OCI CLI profile and the IAM policy (read vnics)."
  [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != null ] || die "the VM has no private IP (is it running?)."
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR"
CACHE_FILE="$CACHE_DIR/bastion-session-$(printf '%s' "$INSTANCE_ID$MODE" | cksum | cut -d' ' -f1)"

session_state() {
  "${OCI[@]}" bastion session get --session-id "$1" --query 'data."lifecycle-state"' --raw-output 2>/dev/null || echo GONE
}

if [ "$ACTION" = close ]; then
  closed=0
  for m in forward managed; do
    f="$CACHE_DIR/bastion-session-$(printf '%s' "$INSTANCE_ID$m" | cksum | cut -d' ' -f1)"
    [ -f "$f" ] || continue
    read -r sid _ <"$f" || true
    [ -n "${sid:-}" ] && { "${OCI[@]}" bastion session delete --session-id "$sid" --force >/dev/null 2>&1 || true; }
    rm -f "$f"
    closed=$((closed + 1))
  done
  if [ "$closed" -gt 0 ]; then info "closed $closed cached session(s)."; else info "no cached session."; fi
  exit 0
fi

# Reuse a cached session when it is ACTIVE and has enough time left.
SESSION_ID=""
now="$(date +%s)"
if [ -f "$CACHE_FILE" ]; then
  read -r sid expires <"$CACHE_FILE" || true
  if [ -n "${sid:-}" ] && [ "${expires:-0}" -gt $((now + MIN_LEFT)) ] && [ "$(session_state "$sid")" = ACTIVE ]; then
    SESSION_ID="$sid"
  else
    rm -f "$CACHE_FILE"
  fi
fi

if [ -z "$SESSION_ID" ]; then
  max_ttl="$("${OCI[@]}" bastion bastion get --bastion-id "$BASTION_ID" \
    --query 'data."max-session-ttl-in-seconds"' --raw-output 2>/dev/null)" ||
    die "couldn't read the bastion." "Check the bastion OCID, the region ($REGION), your profile and the IAM policy (use bastion)."
  case "$max_ttl" in '' | null | *[!0-9]*) max_ttl=10800 ;; esac
  [ "$TTL" -gt "$max_ttl" ] && TTL="$max_ttl"
  [ "$TTL" -lt 1800 ] && TTL=1800 # OCI's minimum session TTL is 30 minutes

  name="aprscaching-$(whoami)-$(date +%Y%m%d-%H%M%S)"
  info "creating a $([ "$MODE" = managed ] && echo "managed SSH" || echo "port-forwarding") session (about a minute)…"
  if [ "$MODE" = managed ]; then
    SESSION_ID="$("${OCI[@]}" bastion session create-managed-ssh --bastion-id "$BASTION_ID" \
      --target-resource-id "$INSTANCE_ID" --target-os-username "$SSH_USER" --target-private-ip "$PRIVATE_IP" \
      --target-port 22 --ssh-public-key-file "$KEY.pub" --session-ttl "$TTL" --display-name "$name" \
      --query 'data.id' --raw-output)" ||
      die "couldn't create the session." "For --managed, the VM's Oracle Cloud Agent needs the Bastion plugin enabled; the default port-forwarding session doesn't."
  else
    SESSION_ID="$("${OCI[@]}" bastion session create-port-forwarding --bastion-id "$BASTION_ID" \
      --target-private-ip "$PRIVATE_IP" --target-port 22 --ssh-public-key-file "$KEY.pub" \
      --session-ttl "$TTL" --display-name "$name" --query 'data.id' --raw-output)" ||
      die "couldn't create the session." "Check the IAM policy (manage bastion-session) and that the bastion targets the VM's subnet."
  fi

  # wait for ACTIVE (creation usually takes under a minute)
  for _ in $(seq 1 60); do
    state="$(session_state "$SESSION_ID")"
    [ "$state" = ACTIVE ] && break
    case "$state" in FAILED | DELETED | DELETING | GONE) die "the session ended up $state." ;; esac
    sleep 3
  done
  [ "$state" = ACTIVE ] || die "the session didn't become active in time (last state: $state)."
  umask 077
  printf '%s %s\n' "$SESSION_ID" "$((now + TTL))" >"$CACHE_FILE"
fi

# The bastion hop: the session OCID is the user name on the bastion's host.
BASTION_SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30 -p 22 "${SESSION_ID}@${BASTION_HOST}")

if [ "$ACTION" = proxy ]; then
  # ssh calls us as ProxyCommand: hand it a raw connection to the VM's port 22.
  exec "${BASTION_SSH[@]}" -W "${PRIVATE_IP}:${PROXY_PORT:-22}"
fi

proxy="$(printf '%q ' "${BASTION_SSH[@]}")-W %h:%p"
info "connecting to $SSH_USER@$PRIVATE_IP through $BASTION_HOST"
exec ssh -i "$KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ProxyCommand="$proxy" \
  "${SSH_USER}@${PRIVATE_IP}" "${SSH_ARGS[@]}"
