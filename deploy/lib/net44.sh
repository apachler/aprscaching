# 44Net: bring an ARDC 44Net Connect WireGuard tunnel up on this host as `wg44`, safely, and keep it checked.
# Sourced by deploy/aprscaching (the `net44` command) and by doctor; the shape modules decide whether the host
# runs the tunnel itself (Self-host, bare metal) or only gets guidance (Pocket and Desktop use a WireGuard app).
#
#   net44 setup <connect.conf> [--name NAME] [--mtu N] [--no-firewall]
#   net44 status
#   net44 check
#   net44 remove
#
# What setup writes, from the configuration Connect issued (kept beside it as wg44.issued.conf, owner-only):
#   - MTU: the path MTU to the endpoint less WireGuard's 80 bytes, at most 1420. wg-quick would take the
#     interface's MTU less 80, which is 8920 on an OCI VM (MTU 9000) while the internet path carries 1500.
#   - PersistentKeepalive = 25 on a peer without one, so NAT and CGNAT keep the tunnel open for inbound traffic.
#   - A full tunnel (AllowedIPs 0.0.0.0/0 or ::/0) gets `Table = off` and policy routing: only traffic from the
#     44.x address uses the tunnel. Routing everything through it would cut the SSH session that set it up.
#     A split tunnel stays as issued.
#   - A firewall on wg44, because ARDC filters nothing and the address is reachable from the whole internet:
#     an nftables input chain and, where Docker publishes the ports, DOCKER-USER rules (Docker's published ports
#     bypass the input chain). Only TCP 80/443 and replies come in. It lives in the tunnel's PostUp/PreDown, so
#     it comes and goes with the tunnel.
# The private key is never printed. A remote change is guarded: the tunnel starts with a rollback scheduled,
# and only an operator who confirms they can still reach the host (or a non-interactive run whose handshake
# succeeded) keeps it and enables it at boot.
# shellcheck shell=bash

N44_IF=wg44
N44_DIR="${APRS_NET44_DIR:-/etc/wireguard}"
N44_TABLE=44
N44_PRIO=4444
N44_MARK=0x44
N44_NFT=aprscaching_wg44
N44_ROLLBACK_S="${APRS_NET44_ROLLBACK_S:-120}"
N44_HANDSHAKE_WAIT_S="${APRS_NET44_HANDSHAKE_WAIT_S:-30}"
N44_MTU_CAP=1420
N44_DOCS="docs/operate/44net.md"

n44_conf() { printf '%s/%s.conf' "$N44_DIR" "$N44_IF"; }
n44_issued() { printf '%s/%s.issued.conf' "$N44_DIR" "$N44_IF"; }
n44_nft_file() { printf '%s/%s.nft' "$N44_DIR" "$N44_IF"; }

# ---- reading a WireGuard configuration ---------------------------------------------------------------------
# n44_values FILE SECTION KEY: every value of KEY in SECTION ([Interface] or [Peer]), comma lists split, one per
# line, trimmed. Keys compare case-insensitively, as wg-quick does.
n44_values() {
  awk -v want="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" -v key="$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]')" '
    /^[ \t]*\[/ { s = tolower($0); gsub(/[ \t\[\]]/, "", s); next }
    s == want {
      line = $0; sub(/#.*/, "", line)
      i = index(line, "="); if (!i) next
      k = tolower(substr(line, 1, i - 1)); gsub(/[ \t]/, "", k)
      if (k != key) next
      n = split(substr(line, i + 1), parts, ",")
      for (j = 1; j <= n; j++) { v = parts[j]; gsub(/^[ \t]+|[ \t\r]+$/, "", v); if (v != "") print v }
    }' "$1"
}

# The tunnel's 44.x IPv4 address (no prefix length), and its IPv6 address if it has one.
n44_v4() { n44_values "$1" interface address | sed 's|/.*||' | grep -E '^44\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true; }
n44_v6() { n44_values "$1" interface address | sed 's|/.*||' | grep ':' | head -n 1 || true; }

n44_full_v4() { n44_values "$1" peer allowedips | grep -qx '0\.0\.0\.0/0'; }
n44_full_v6() { n44_values "$1" peer allowedips | grep -qx '::/0'; }
n44_full() { n44_full_v4 "$1" || n44_full_v6 "$1"; }

# The endpoint's host, without the port (and without brackets for an IPv6 literal).
n44_endpoint_host() {
  local ep
  ep="$(n44_values "$1" peer endpoint | head -n 1)"
  case "$ep" in
    \[*\]:*) ep="${ep#\[}"; printf '%s' "${ep%%\]*}" ;;
    *) printf '%s' "${ep%:*}" ;;
  esac
}

# n44_validate FILE: a 44Net Connect configuration this helper can use, or a reason why not.
n44_validate() {
  [ -f "$1" ] || die "No configuration at $1."
  [ -n "$(n44_values "$1" interface privatekey)" ] || die "$1 has no [Interface] PrivateKey." "Use the configuration 44Net Connect issued for this device."
  [ -n "$(n44_v4 "$1")" ] || die "$1 has no 44.x address in [Interface] Address."
  [ -n "$(n44_values "$1" peer endpoint)" ] || die "$1 has no [Peer] Endpoint."
  [ -n "$(n44_values "$1" peer allowedips)" ] || die "$1 has no [Peer] AllowedIPs."
}

# ---- the MTU (G9) -------------------------------------------------------------------------------------------
# The largest packet that reaches HOST without fragmenting, by pings with Don't Fragment set (28 bytes of IP and
# ICMP header on top of the payload); empty when HOST does not answer pings at all.
n44_probe_pmtu() {
  local host="$1" lo=1280 hi=1500 mid
  have ping || return 0
  ping -c 1 -W 2 -M "do" -s $((lo - 28)) "$host" >/dev/null 2>&1 || return 0
  if ping -c 1 -W 2 -M "do" -s $((hi - 28)) "$host" >/dev/null 2>&1; then printf '%s' "$hi"; return 0; fi
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(((lo + hi) / 2))
    if ping -c 1 -W 2 -M "do" -s $((mid - 28)) "$host" >/dev/null 2>&1; then lo="$mid"; else hi="$mid"; fi
  done
  printf '%s' "$lo"
}

# n44_mtu_for PMTU: the tunnel MTU for a path MTU: 80 bytes less (WireGuard over IPv6 worst case), at most 1420.
n44_mtu_for() {
  local m=$(($1 - 80))
  [ "$m" -le "$N44_MTU_CAP" ] || m="$N44_MTU_CAP"
  printf '%s' "$m"
}

# ---- the firewall (G10) ---------------------------------------------------------------------------------------
# n44_nft_rules PORTS: the nftables table for wg44; PORTS is "80,443".
n44_nft_rules() {
  local ports="${1//,/, }"
  cat <<NFT
# Written by deploy/aprscaching net44: only TCP ${1} and replies come in on ${N44_IF}.
table inet ${N44_NFT} {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "${N44_IF}" ct state established,related accept
    iifname "${N44_IF}" tcp dport { ${ports} } accept
    iifname "${N44_IF}" icmp type { echo-request, destination-unreachable } accept
    iifname "${N44_IF}" icmpv6 type { echo-request, packet-too-big, destination-unreachable } accept
    iifname "${N44_IF}" drop
  }
}
NFT
}

# The DOCKER-USER rules, in the order iptables -I leaves them: replies, the ports, then drop.
n44_docker_rules() {
  printf '%s\n' "-i %i -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" \
    "-i %i -p tcp -m multiport --dports $1 -j RETURN" "-i %i -j DROP"
}

# n44_policy FAMILY IPTABLES ADDRESS: the PostUp/PreDown lines of the policy routing for one address family.
n44_policy() {
  local f="$1" ipt="$2" addr="$3" r
  local rules=(
    "-t mangle -A PREROUTING -i %i -m conntrack --ctstate NEW -j CONNMARK --set-mark $N44_MARK"
    "-t mangle -A PREROUTING ! -i %i -m connmark --mark $N44_MARK -j CONNMARK --restore-mark"
    "-t mangle -A OUTPUT -m connmark --mark $N44_MARK -j CONNMARK --restore-mark"
  )
  # each PostUp line tolerates what an unclean earlier stop left behind, since wg-quick aborts on a failed hook
  printf 'PostUp = ip -%s rule del from %s lookup %s priority %s 2>/dev/null || true; ip -%s rule add from %s lookup %s priority %s\n' \
    "$f" "$addr" "$N44_TABLE" "$N44_PRIO" "$f" "$addr" "$N44_TABLE" "$N44_PRIO"
  printf 'PostUp = ip -%s rule del fwmark %s lookup %s priority %s 2>/dev/null || true; ip -%s rule add fwmark %s lookup %s priority %s\n' \
    "$f" "$N44_MARK" "$N44_TABLE" "$((N44_PRIO - 1))" "$f" "$N44_MARK" "$N44_TABLE" "$((N44_PRIO - 1))"
  printf 'PostUp = ip -%s route replace default dev %%i table %s\n' "$f" "$N44_TABLE"
  for r in "${rules[@]}"; do printf 'PostUp = %s %s 2>/dev/null || %s %s\n' "$ipt" "${r/ -A / -C }" "$ipt" "$r"; done
  for r in "${rules[@]}"; do printf 'PreDown = %s %s || true\n' "$ipt" "${r/ -A / -D }"; done
  printf 'PreDown = ip -%s rule del from %s lookup %s priority %s || true; ip -%s rule del fwmark %s lookup %s priority %s || true; ip -%s route flush table %s || true\n' \
    "$f" "$addr" "$N44_TABLE" "$N44_PRIO" "$f" "$N44_MARK" "$N44_TABLE" "$((N44_PRIO - 1))" "$f" "$N44_TABLE"
}

# ---- the configuration this helper writes ---------------------------------------------------------------------
# n44_render ISSUED MTU PORTS FIREWALL DOCKER: the wg44.conf to write. FIREWALL and DOCKER are 1 or 0.
n44_render() {
  local issued="$1" mtu="$2" ports="$3" fw="$4" docker="$5" v4 v6 add="" rule
  v4="$(n44_v4 "$issued")"
  v6="$(n44_v6 "$issued")"
  add+="MTU = $mtu"$'\n'
  if n44_full "$issued"; then
    # Only the 44Net address's own traffic takes the tunnel: what the host sends from it (the rule on the source),
    # and replies to connections that came in on wg44 (a connection mark). Docker's replies need the mark: they
    # leave the container with its own address and become 44.x only after routing.
    add+="Table = off"$'\n'
    n44_full_v4 "$issued" && add+="$(n44_policy 4 iptables "$v4")"$'\n'
    if [ -n "$v6" ] && n44_full_v6 "$issued"; then add+="$(n44_policy 6 ip6tables "$v6")"$'\n'; fi
  fi
  if [ "$fw" = 1 ]; then
    add+="PostUp = nft delete table inet $N44_NFT 2>/dev/null || true; nft -f $(n44_nft_file)"$'\n'
    add+="PreDown = nft delete table inet $N44_NFT || true"$'\n'
    if [ "$docker" = 1 ]; then
      # Docker's published ports pass FORWARD, not INPUT; DOCKER-USER is the chain Docker leaves to the operator
      add+="PostUp = iptables -N DOCKER-USER 2>/dev/null || true"$'\n'
      while IFS= read -r rule; do
        add+="PostUp = iptables -C DOCKER-USER $rule 2>/dev/null || iptables -I DOCKER-USER $rule"$'\n'
      done < <(n44_docker_rules "$ports" | tac)
      while IFS= read -r rule; do add+="PreDown = iptables -D DOCKER-USER $rule || true"$'\n'; done < <(n44_docker_rules "$ports")
    fi
  fi
  printf '# Written by deploy/aprscaching net44 from %s; change that file, then run setup again.\n' "$(basename "$(n44_issued)")"
  ADD="$add" awk '
    function flush_peer() { if (inpeer && !keep) print "PersistentKeepalive = 25"; inpeer = 0; keep = 0 }
    function close_iface() { if (iniface) { printf "%s", ENVIRON["ADD"]; iniface = 0 } }
    /^[ \t]*\[/ {
      flush_peer(); close_iface()
      while (blank > 0) { print ""; blank-- }
      s = tolower($0); gsub(/[ \t\[\]]/, "", s)
      if (s == "interface") iniface = 1
      if (s == "peer") inpeer = 1
      print; next
    }
    {
      k = $0; sub(/=.*/, "", k); k = tolower(k); gsub(/[ \t]/, "", k)
      if (iniface && (k == "mtu" || k == "table")) next
      if (inpeer && k == "persistentkeepalive") keep = 1
      if (/^[ \t]*$/) { blank++; next }
      while (blank > 0) { print ""; blank-- }
      print
    }
    END { flush_peer(); close_iface() }
  ' "$issued"
}

# ---- FED_ENDPOINTS ---------------------------------------------------------------------------------------------
# n44_endpoints_with VALUE APP_URL NAME: VALUE with its 44net endpoint set to NAME (added when there is none).
n44_endpoints_with() {
  local v="$1" app="$2" name="$3" e
  e="{\"transport\":\"44net\",\"address\":\"$name\",\"priority\":20}"
  if [ -z "$v" ] || [ "$v" = "[]" ]; then
    printf '[{"transport":"https","address":"%s","priority":10},%s]' "$app" "$e"
  elif printf '%s' "$v" | grep -q '"transport":"44net"'; then
    printf '%s' "$v" | sed -E "s/\\{\"transport\":\"44net\"[^}]*\\}/$e/"
  else
    printf '%s' "${v%]},$e]"
  fi
}

# n44_endpoints_without VALUE: VALUE without its 44net endpoint.
n44_endpoints_without() {
  printf '%s' "$1" | sed -E -e 's/,\{"transport":"44net"[^}]*\}//' -e 's/\{"transport":"44net"[^}]*\},?//'
}

n44_name_from_env() {
  [ -n "${SHAPE_ENV:-}" ] || return 0
  env_file_get "$SHAPE_ENV" FED_ENDPOINTS | { grep -oE '"transport":"44net","address":"[^"]+"' || true; } |
    sed 's/.*"address":"//; s/"$//' | head -n 1
}

# ---- state of the host -------------------------------------------------------------------------------------------
n44_up() { ip link show "$N44_IF" >/dev/null 2>&1; }

# Seconds since the newest handshake on wg44; empty when there has been none.
n44_handshake_age() {
  local t
  t="$(wg show "$N44_IF" latest-handshakes 2>/dev/null | awk '{ if ($2 > m) m = $2 } END { print m + 0 }')"
  [ "${t:-0}" -gt 0 ] || return 0
  printf '%s' $(($(date +%s) - t))
}

n44_wait_handshake() {
  local waited=0
  while [ "$waited" -lt "$N44_HANDSHAKE_WAIT_S" ]; do
    [ -z "$(n44_handshake_age)" ] || return 0
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Other firewalls on the host, which filter wg44 too and stay the operator's to configure.
n44_other_firewalls() {
  if have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then
    printf '%s\n' "ufw is active: allow the ports on the tunnel too, e.g. ufw allow in on $N44_IF to any port 80,443 proto tcp"
  fi
  if have systemctl && systemctl is-active --quiet firewalld 2>/dev/null; then
    printf '%s\n' "firewalld is active: add $N44_IF to a zone that allows http and https"
  fi
  if have iptables && iptables -S INPUT 2>/dev/null | grep -q 'icmp-host-prohibited'; then
    printf '%s\n' "the host's iptables rejects input it does not list (as OCI's images do); the published ports pass FORWARD and are unaffected"
  fi
}

# The ports the tunnel lets in: Caddy's 80 and 443, and on bare metal the gateway's own port when APP_URL has one.
n44_ports() {
  local app port
  app="$( [ -n "${SHAPE_ENV:-}" ] && env_file_get "$SHAPE_ENV" APP_URL || true)"
  port="$(printf '%s' "$app" | sed -nE 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#p')"
  if [ -n "$port" ] && [ "$port" != 80 ] && [ "$port" != 443 ]; then printf '80,443,%s' "$port"; else printf '80,443'; fi
}

n44_need_root() {
  [ -n "${APRS_NET44_DIR:-}" ] || [ "$(id -u)" = 0 ] || die "net44 changes the network: run it with sudo."
}

# ---- guidance for shapes that use a WireGuard app ----------------------------------------------------------------
n44_guidance() {
  local file="${1:-}" mtu="" pmtu host
  step "44Net on the $SHAPE shape: the WireGuard app carries the tunnel"
  if [ -n "$file" ] && [ -f "$file" ] && host="$(n44_endpoint_host "$file")" && [ -n "$host" ]; then
    pmtu="$(n44_probe_pmtu "$host")"
    [ -z "$pmtu" ] || mtu="$(n44_mtu_for "$pmtu")"
  fi
  info "1. Install the official WireGuard app and import the configuration 44Net Connect issued."
  info "2. Edit the tunnel: set MTU to ${mtu:-1420}${mtu:+ (the path to the endpoint carries $pmtu bytes)}${mtu:-, or lower on PPPoE (1412) or DS-Lite (1372)}."
  info "3. Under the peer, set Persistent keepalive to 25, so the tunnel stays open for inbound traffic."
  info "4. Keep AllowedIPs as issued; a full tunnel (0.0.0.0/0) sends all of this device's traffic through 44Net."
  info "5. Turn the tunnel on, then: deploy/aprscaching net44 status, and net44 check."
  info "Details: $N44_DOCS"
}

# ---- commands ---------------------------------------------------------------------------------------------------------
n44_shape_mode() {
  case "$SHAPE" in
    selfhost) echo docker ;;
    baremetal) echo host ;;
    pocket | desktop) echo guide ;;
    *) echo none ;;
  esac
}

net44_setup() {
  local file="" name="" mtu="" fw=1 mode issued conf new pmtu host v4 ports docker=0 changed=1 line
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift ;;
      --mtu) mtu="$2"; shift ;;
      --no-firewall) fw=0 ;;
      -h | --help)
        printf '%s\n' "deploy/aprscaching net44 setup <connect.conf> [--name NAME] [--mtu N] [--no-firewall]" \
          "Brings the 44Net Connect tunnel up as $N44_IF, with a safe MTU, keepalive, routing that keeps SSH and a" \
          "firewall that lets only TCP 80/443 in; --name adds the 44Net name to FED_ENDPOINTS."
        return 0
        ;;
      -*) die "Unknown option $1." ;;
      *) file="$1" ;;
    esac
    shift
  done
  mode="$(n44_shape_mode)"
  case "$mode" in
    guide) n44_guidance "$file"; return 0 ;;
    none) die "44Net is not set up on the $SHAPE shape." "Set it up on the machine that runs the gateway (Self-host, bare metal, Pocket or Desktop)." ;;
  esac
  [ -n "$file" ] || die "setup needs the configuration 44Net Connect issued: deploy/aprscaching net44 setup <file>"
  case "$mtu" in '' | [0-9]*) ;; *) die "--mtu takes a number, e.g. 1420." ;; esac
  case "$name" in '' | *.ampr.org) ;; *) die "--name takes the instance's 44Net name, e.g. aprscaching.oe8apr.ampr.org." ;; esac
  n44_validate "$file"
  n44_need_root
  for line in wg wg-quick ip; do
    have "$line" || die "$line is not installed." "Install WireGuard's tools first: apt-get install wireguard-tools nftables"
  done
  [ "$fw" = 0 ] || have nft || die "nft is not installed." "Install it (apt-get install nftables), or pass --no-firewall and filter $N44_IF yourself."
  [ "$mode" = docker ] && docker=1

  issued="$(n44_issued)"
  conf="$(n44_conf)"
  v4="$(n44_v4 "$file")"
  ports="$(n44_ports)"
  if [ -z "$mtu" ]; then
    host="$(n44_endpoint_host "$file")"
    pmtu="$(n44_probe_pmtu "$host")"
    if [ -n "$pmtu" ]; then
      mtu="$(n44_mtu_for "$pmtu")"
    else
      mtu="$N44_MTU_CAP"
      warn "$host does not answer pings, so the path MTU is unknown: using $mtu. On PPPoE use --mtu 1412, on DS-Lite --mtu 1372."
    fi
  fi

  (umask 077 && mkdir -p "$N44_DIR")
  new="$(umask 077 && mktemp)"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -f '$new'" EXIT
  n44_render "$file" "$mtu" "$ports" "$fw" "$docker" >"$new"
  if [ -f "$conf" ] && cmp -s "$new" "$conf" && n44_up; then changed=0; fi

  step "44Net tunnel $N44_IF"
  info "address: $v4$( [ -z "$(n44_v6 "$file")" ] || printf ', %s' "$(n44_v6 "$file")")"
  info "endpoint: $(n44_values "$file" peer endpoint | head -n 1)"
  info "MTU: $mtu${pmtu:+ (path MTU $pmtu less 80, at most $N44_MTU_CAP)}"
  if n44_full "$file"; then
    info "routing: a full tunnel, so only traffic from $v4 and replies to what comes in on $N44_IF use it; SSH and the rest stay on the internet link"
  else
    info "routing: a split tunnel, as issued: it carries 44Net traffic only, so hosts outside 44/8 cannot reach $v4"
    info "  (for reachability from the whole internet, use a full-tunnel configuration; this helper keeps SSH on the internet link)"
  fi
  if [ "$fw" = 1 ]; then
    info "firewall: only TCP $ports and replies come in on $N44_IF$([ "$docker" = 0 ] || printf ' (nftables, and DOCKER-USER for the published ports)')"
  else
    warn "no firewall (--no-firewall): the whole internet can reach every port on $v4"
  fi
  while IFS= read -r line; do [ -z "$line" ] || info "note: $line"; done < <(n44_other_firewalls)
  if [ "$changed" = 0 ]; then
    info "already up with this configuration; nothing to change"
  else
    confirm "Write $conf and start the tunnel? A rollback takes it down after ${N44_ROLLBACK_S}s unless you confirm." ||
      die "Nothing changed." "Pass --yes to go ahead without asking."
    [ "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")" = "$issued" ] || install -m 600 "$file" "$issued"
    [ "$fw" = 0 ] || (umask 077 && n44_nft_rules "$ports" >"$(n44_nft_file)")
    install -m 600 "$new" "$conf"
    n44_start
  fi
  n44_apply_name "$name"
  step "Next"
  info "1. In the 44Net Portal, point an A record for your 44Net name at $v4."
  info "2. Publish the _aprscaching TXT record that Instance admin -> Setup -> 44Net shows."
  info "3. From another network (a phone on mobile data): curl -fsS http://<your 44Net name>/health"
  info "4. deploy/aprscaching net44 check, and deploy/aprscaching doctor"
  info "Details, including TLS on the 44Net name: $N44_DOCS"
}

# Start (or restart) wg44 under a scheduled rollback; keep it only once the operator, or the handshake, says so.
n44_start() {
  local ok=0 answer=""
  systemctl stop "wg-quick@$N44_IF" 2>/dev/null || true
  wg-quick down "$N44_IF" >/dev/null 2>&1 || true
  systemctl stop aprscaching-net44-rollback.timer 2>/dev/null || true
  systemctl reset-failed aprscaching-net44-rollback.service aprscaching-net44-rollback.timer 2>/dev/null || true
  systemd-run --quiet --unit aprscaching-net44-rollback --on-active="${N44_ROLLBACK_S}s" \
    systemctl stop "wg-quick@$N44_IF" || die "Could not schedule the rollback (systemd-run); nothing started."
  if ! systemctl start "wg-quick@$N44_IF"; then
    systemctl stop aprscaching-net44-rollback.timer 2>/dev/null || true
    die "The tunnel did not start." "journalctl -u wg-quick@$N44_IF says why."
  fi
  if n44_wait_handshake; then info "handshake with the endpoint: ok"; else warn "no handshake within ${N44_HANDSHAKE_WAIT_S}s"; fi
  if can_ask && [ "$APRS_ASSUME_YES" != 1 ]; then
    printf '%s' "Open a NEW SSH session to this host now. Does it connect? [y/N] (the rollback runs in ${N44_ROLLBACK_S}s) " >&2
    if [ -t 0 ]; then read -r -t "$((N44_ROLLBACK_S - 10))" answer || true; else read -r -t "$((N44_ROLLBACK_S - 10))" answer </dev/tty || true; fi
    case "$answer" in [yY]*) ok=1 ;; esac
  elif [ -n "$(n44_handshake_age)" ]; then
    ok=1
  fi
  if [ "$ok" = 1 ]; then
    systemctl stop aprscaching-net44-rollback.timer 2>/dev/null || true
    systemctl enable "wg-quick@$N44_IF" >/dev/null 2>&1 || true
    info "kept: $N44_IF is up, and starts at boot"
  else
    systemctl stop "wg-quick@$N44_IF" 2>/dev/null || true
    systemctl stop aprscaching-net44-rollback.timer 2>/dev/null || true
    die "Rolled back: $N44_IF is down and does not start at boot." \
      "The configuration stays at $(n44_conf); check the endpoint and the routing, then run setup again."
  fi
}

n44_apply_name() {
  local name="$1" app cur
  [ -n "${SHAPE_ENV:-}" ] && [ -f "${SHAPE_ENV:-}" ] || return 0
  if [ -z "$name" ]; then
    [ -z "$(n44_name_from_env)" ] || return 0
    ask name "This instance's 44Net name for FED_ENDPOINTS (e.g. aprscaching.<call>.ampr.org; blank = later)" ""
    [ -n "$name" ] || return 0
    case "$name" in *.ampr.org) ;; *) warn "$name is not an ampr.org name; FED_ENDPOINTS unchanged"; return 0 ;; esac
  fi
  app="$(env_file_get "$SHAPE_ENV" APP_URL)"
  cur="$(env_file_get "$SHAPE_ENV" FED_ENDPOINTS)"
  # single-quoted, as compose and systemd both read a quoted JSON value intact
  env_file_set "$SHAPE_ENV" FED_ENDPOINTS "'$(n44_endpoints_with "$cur" "$app" "$name")'"
  info "FED_ENDPOINTS: added the 44net endpoint $name; restart the instance to publish it"
}

net44_status() {
  local age conf mode
  conf="$(n44_conf)"
  step "44Net tunnel $N44_IF"
  if [ "$(n44_shape_mode)" = guide ]; then info "on $SHAPE the WireGuard app carries the tunnel; showing what this host sees"; fi
  if ! n44_up; then
    info "interface: down$([ -f "$conf" ] && printf ' (configured in %s)' "$conf")"
    return 0
  fi
  info "interface: up, $(ip -o addr show dev "$N44_IF" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
  age="$(n44_handshake_age)"
  info "handshake: ${age:+$age s ago}${age:-none yet}"
  info "transfer: $(wg show "$N44_IF" transfer 2>/dev/null | awk '{printf "%s B in, %s B out", $2, $3}')"
  info "MTU: $(ip -o link show dev "$N44_IF" 2>/dev/null | sed -nE 's/.* mtu ([0-9]+).*/\1/p')"
  mode="split tunnel, as issued"
  [ -f "$conf" ] && n44_values "$conf" interface table | grep -qix off && mode="full tunnel, policy routing from the 44Net address"
  info "routing: $mode"
  if have nft && nft list table inet "$N44_NFT" >/dev/null 2>&1; then info "firewall: on (nftables $N44_NFT)"; else info "firewall: none from this helper"; fi
  if have iptables && iptables -S DOCKER-USER 2>/dev/null | grep -q -- "-i $N44_IF -j DROP"; then info "DOCKER-USER: filters $N44_IF"; fi
  info "enabled at boot: $(systemctl is-enabled "wg-quick@$N44_IF" 2>/dev/null || echo no)"
}

# DNS through DOH_URL (JSON API): the answers' data, one per line.
n44_doh() {
  local doh
  doh="$( [ -n "${SHAPE_ENV:-}" ] && env_file_get "$SHAPE_ENV" DOH_URL || true)"
  doh="${doh:-https://cloudflare-dns.com/dns-query}"
  curl -fsS --max-time 10 -H 'accept: application/dns-json' "$doh?name=$1&type=$2" 2>/dev/null |
    grep -oE '"data": ?"([^"\\]|\\.)*"' | sed -E 's/^"data": ?"//; s/"$//; s/\\"//g' || true
}

net44_check() {
  local name a v4 txt bad=0
  name="${1:-$(n44_name_from_env)}"
  [ -n "$name" ] || die "No 44Net name: FED_ENDPOINTS has no 44net endpoint." "Pass it: deploy/aprscaching net44 check <name>"
  step "44Net name $name"
  a="$(n44_doh "$name" A | grep -E '^[0-9.]+$' | head -n 1)"
  v4="$( [ -f "$(n44_conf)" ] && n44_v4 "$(n44_conf)" || true)"
  case "$a" in
    '') info "FAIL A record: none; add it in the 44Net Portal${v4:+, pointing at $v4}"; bad=1 ;;
    44.*) if [ -n "$v4" ] && [ "$a" != "$v4" ]; then info "FAIL A record: $a, but the tunnel is $v4"; bad=1; else info "ok   A record: $a"; fi ;;
    *) info "WARN A record: $a is outside 44/8" ;;
  esac
  txt="$(n44_doh "_aprscaching.$name" TXT | grep 'v=acs1' | head -n 1)"
  [ -n "$txt" ] || txt="$(n44_doh "_aprscaching.${name#*.}" TXT | grep 'v=acs1' | head -n 1)"
  if [ -n "$txt" ]; then info "ok   _aprscaching TXT: $txt"; else info "FAIL _aprscaching TXT: none; Instance admin -> Setup -> 44Net shows the value"; bad=1; fi
  info "Reachability needs a test from outside: on another network (a phone on mobile data) run"
  info "  curl -fsS http://$name/health"
  [ "$bad" = 0 ]
}

net44_remove() {
  local conf cur
  conf="$(n44_conf)"
  [ "$(n44_shape_mode)" != guide ] || { info "On $SHAPE, turn the tunnel off and delete it in the WireGuard app."; return 0; }
  n44_need_root
  confirm "Take $N44_IF down, stop it starting at boot, and remove its firewall?" || die "Nothing changed." "Pass --yes to go ahead."
  systemctl disable --now "wg-quick@$N44_IF" 2>/dev/null || wg-quick down "$N44_IF" 2>/dev/null || true
  rm -f "$conf" "$(n44_nft_file)"
  info "removed $conf and the firewall; the tunnel is down"
  if [ -f "$(n44_issued)" ] && confirm "Delete the configuration 44Net Connect issued ($(n44_issued)) too?"; then
    rm -f "$(n44_issued)"
    info "removed $(n44_issued)"
  fi
  if [ -n "${SHAPE_ENV:-}" ] && [ -f "$SHAPE_ENV" ]; then
    cur="$(env_file_get "$SHAPE_ENV" FED_ENDPOINTS)"
    if printf '%s' "$cur" | grep -q '"transport":"44net"'; then
      env_file_set "$SHAPE_ENV" FED_ENDPOINTS "'$(n44_endpoints_without "$cur")'"
      info "FED_ENDPOINTS: removed the 44net endpoint; restart the instance"
    fi
  fi
}

# init's offer (Self-host, bare metal): FILE from --net44-config, else asked when someone can answer; then net44
# setup for the recorded shape, as root.
n44_init_offer() {
  local file="$1" args=(--shape "$SHAPE" net44 setup)
  if [ -z "$file" ] && can_ask; then
    ask file "A 44Net Connect WireGuard configuration to bring up now (a file path; blank = none)" ""
  fi
  [ -n "$file" ] || return 0
  [ -f "$file" ] || die "No 44Net configuration at $file."
  file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  [ "$APRS_INTERACTIVE" = 1 ] || args+=(--non-interactive)
  [ "$APRS_ASSUME_YES" = 1 ] && args+=(--yes)
  if [ "$(id -u)" = 0 ] || [ -n "${APRS_NET44_DIR:-}" ]; then
    "$DEPLOY_DIR/aprscaching" "${args[@]}" "$file"
  else
    sudo "$DEPLOY_DIR/aprscaching" "${args[@]}" "$file"
  fi
}

run_net44() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift
  case "$sub" in
    setup) net44_setup "$@" ;;
    status) net44_status "$@" ;;
    check) net44_check "$@" ;;
    remove) net44_remove "$@" ;;
    *) die "net44 takes setup, status, check or remove." "deploy/aprscaching net44 setup <connect.conf>" ;;
  esac
}
