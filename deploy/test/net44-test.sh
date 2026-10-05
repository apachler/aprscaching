#!/usr/bin/env bash
# Checks of deploy/aprscaching net44 (deploy/lib/net44.sh) with WireGuard, ip, systemd, nft, iptables, ping and
# DNS-over-HTTPS mocked on PATH: the configuration it writes from a Connect configuration (MTU, keepalive, full
# tunnel → policy routing, split as issued, the firewall), the rollback guard, an idempotent re-run,
# FED_ENDPOINTS, status, check, remove, and the guidance on shapes that use a WireGuard app.
#
#   bash deploy/test/net44-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
H="$DEPLOY/aprscaching"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
check() { # check "name" command…
  local name="$1"
  shift
  if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; FAILED=1; fi
}
fails() { ! "$@"; }
eq() { [ "$1" = "$2" ] || { printf '     got: %s\n     want: %s\n' "$1" "$2"; return 1; }; }

mkdir -p "$TMP/bin"
export MOCK_LOG="$TMP/calls" MOCK_STATE="$TMP/state"
mkdir -p "$MOCK_STATE"
mock() { printf '#!/usr/bin/env bash\necho "%s $*" >>"$MOCK_LOG"\n%s\n' "$1" "$2" >"$TMP/bin/$1"; chmod +x "$TMP/bin/$1"; }
# the tunnel is up while $MOCK_STATE/up exists; a handshake is recent unless $MOCK_STATE/nohandshake exists
mock systemctl 'case "$*" in
  "start wg-quick@wg44") : >"$MOCK_STATE/up" ;;
  "stop wg-quick@wg44" | "disable --now wg-quick@wg44") rm -f "$MOCK_STATE/up" ;;
  "is-enabled wg-quick@wg44") echo enabled ;;
  "is-active --quiet firewalld") exit 1 ;;
esac'
mock systemd-run ':'
mock wg-quick 'case "$1" in down) rm -f "$MOCK_STATE/up" ;; esac'
mock wg 'case "$*" in
  *latest-handshakes*) if [ -e "$MOCK_STATE/nohandshake" ]; then echo "PEERKEY= 0"; else echo "PEERKEY= $(date +%s)"; fi ;;
  *transfer*) echo "PEERKEY= 1200 3400" ;;
esac'
mock ip 'case "$*" in
  "link show wg44") [ -e "$MOCK_STATE/up" ] ;;
  "-o addr show dev wg44") echo "9: wg44 inet 44.27.132.9/32 scope global wg44" ;;
  "-o link show dev wg44") echo "9: wg44: <POINTOPOINT,NOARP,UP> mtu 1420 qdisc noqueue" ;;
esac'
# ping: answers packets up to $MOCK_PMTU bytes (payload + 28), or none when it is 0
mock ping 'size=0; while [ $# -gt 0 ]; do [ "$1" = -s ] && size="$2"; shift; done
[ "${MOCK_PMTU:-1500}" -gt 0 ] && [ $((size + 28)) -le "${MOCK_PMTU:-1500}" ]'
mock nft 'case "$*" in "list table inet aprscaching_wg44") [ -e "$MOCK_STATE/up" ] ;; esac'
mock iptables 'case "$*" in "-S DOCKER-USER") [ -e "$MOCK_STATE/up" ] && echo "-A DOCKER-USER -i wg44 -j DROP" ;; esac'
mock ufw 'echo "Status: inactive"'
# DNS-over-HTTPS: the A record and the _aprscaching TXT record of the test name
mock curl 'case "$*" in
  *"name=aprscaching.oe8apr.ampr.org&type=A"*) echo "{\"Status\":0,\"Answer\":[{\"name\":\"x\",\"type\":1,\"data\":\"${MOCK_A:-44.27.132.9}\"}]}" ;;
  *"name=_aprscaching.oe8apr.ampr.org&type=TXT"*)
    if [ -n "${MOCK_NO_TXT:-}" ]; then echo "{\"Status\":0}"
    elif [ -n "${MOCK_VERIFY_ONLY:-}" ]; then echo "{\"Status\":0,\"Answer\":[{\"data\":\"\\\"v=acs1; verify=abc\\\"\"}]}"
    else echo "{\"Status\":0,\"Answer\":[{\"data\":\"\\\"v=acs1; inst=aprs.example.net; key=abc\\\"\"}]}"; fi ;;
  *) echo "{\"Status\":0}" ;;
esac'
export PATH="$TMP/bin:$PATH"

export APRS_NET44_DIR="$TMP/wireguard" APRS_NET44_ROLLBACK_S=20 APRS_NET44_HANDSHAKE_WAIT_S=4
export APRSCACHING_SHAPE_FILE="$TMP/shape"
ENVF="$TMP/deploy.env"
printf 'shape=selfhost\nenv=%s\n' "$ENVF" >"$APRSCACHING_SHAPE_FILE"
printf 'APP_URL=https://aprs.example.net\nDOMAIN=aprs.example.net\n' >"$ENVF"
chmod 600 "$ENVF"
CONF="$APRS_NET44_DIR/wg44.conf"

# A full-tunnel configuration as 44Net Connect issues one (the key is a dummy).
cat >"$TMP/full.conf" <<'WG'
[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHI=
Address = 44.27.132.9/32, 2a0e:1234::9/128
DNS = 44.0.0.1

[Peer]
PublicKey = cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHVibGk=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = connect.example.net:51820
WG
sed -e 's|AllowedIPs = .*|AllowedIPs = 44.0.0.0/8|' -e 's|^Endpoint.*|&\nPersistentKeepalive = 15|' "$TMP/full.conf" >"$TMP/split.conf"

n44() { "$H" net44 "$@" </dev/null >"$TMP/out" 2>"$TMP/err"; }
in_conf() { grep -qxF -- "$1" "$CONF"; }
called() { grep -qF -- "$1" "$MOCK_LOG"; }

# ---- the rendered configuration ---------------------------------------------------------------------------
: >"$MOCK_LOG"
check "a full-tunnel setup succeeds" env MOCK_PMTU=1492 bash -c "$(declare -f n44); H='$H' TMP='$TMP' n44 setup --yes --non-interactive '$TMP/full.conf' --name aprscaching.oe8apr.ampr.org"
check "  … owner-only" eq "$(stat -c %a "$CONF")" 600
check "  … and prints the Portal records for the name, the TXT naming both places" bash -c "grep -q 'aprscaching  A    44.27.132.9' '$TMP/out' && grep -q '_aprscaching  TXT  \"v=acs1; inst=aprs.example.net; key=<federation key>; host=aprscaching.oe8apr.ampr.org; web=https://aprs.example.net\"' '$TMP/out'"
check "  … keeps the issued configuration beside it, owner-only" eq "$(stat -c %a "$APRS_NET44_DIR/wg44.issued.conf")" 600
check "  … MTU is the path MTU (PPPoE 1492) less 80" in_conf "MTU = 1412"
check "  … with Table = off" in_conf "Table = off"
check "  … and a policy rule for the 44Net address only" \
  in_conf "PostUp = ip -4 rule del from 44.27.132.9 lookup 44 priority 4444 2>/dev/null || true; ip -4 rule add from 44.27.132.9 lookup 44 priority 4444"
check "  … whose table sends through the tunnel" in_conf "PostUp = ip -4 route replace default dev %i table 44"
check "  … and replies to connections in on wg44 (Docker's too) by a connection mark" bash -c "
  grep -qxF 'PostUp = iptables -t mangle -C PREROUTING -i %i -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x44 2>/dev/null || iptables -t mangle -A PREROUTING -i %i -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x44' '$CONF' &&
  grep -qxF 'PostUp = iptables -t mangle -C PREROUTING ! -i %i -m connmark --mark 0x44 -j CONNMARK --restore-mark 2>/dev/null || iptables -t mangle -A PREROUTING ! -i %i -m connmark --mark 0x44 -j CONNMARK --restore-mark' '$CONF' &&
  grep -qxF 'PostUp = ip -4 rule del fwmark 0x44 lookup 44 priority 4443 2>/dev/null || true; ip -4 rule add fwmark 0x44 lookup 44 priority 4443' '$CONF'"
check "  … the same for IPv6" in_conf "PostUp = ip -6 rule del from 2a0e:1234::9 lookup 44 priority 4444 2>/dev/null || true; ip -6 rule add from 2a0e:1234::9 lookup 44 priority 4444"
check "  … removed again on the way down" bash -c "
  grep -qxF 'PreDown = ip -4 rule del from 44.27.132.9 lookup 44 priority 4444 || true; ip -4 rule del fwmark 0x44 lookup 44 priority 4443 || true; ip -4 route flush table 44 || true' '$CONF' &&
  grep -qxF 'PreDown = iptables -t mangle -D OUTPUT -m connmark --mark 0x44 -j CONNMARK --restore-mark || true' '$CONF'"
check "  … adds keepalive 25 to the peer" bash -c "awk '/^\[Peer\]/{p=1} p' '$CONF' | grep -qx 'PersistentKeepalive = 25'"
check "  … keeps the issued lines" bash -c "grep -qx 'AllowedIPs = 0.0.0.0/0, ::/0' '$CONF' && grep -qx 'Endpoint = connect.example.net:51820' '$CONF'"
check "  … the firewall lets only 80 and 443 in on wg44" \
  bash -c "grep -q 'tcp dport { 80, 443 } accept' '$APRS_NET44_DIR/wg44.nft' && grep -q 'iifname \"wg44\" drop' '$APRS_NET44_DIR/wg44.nft'"
check "  … loaded with the tunnel" in_conf "PostUp = nft delete table inet aprscaching_wg44 2>/dev/null || true; nft -f $APRS_NET44_DIR/wg44.nft"
check "  … and DOCKER-USER drops the rest, after replies and the ports" bash -c "
  [ \"\$(grep 'PostUp = iptables -C DOCKER-USER' '$CONF' | sed 's/.*|| iptables -I DOCKER-USER //')\" = \"\$(printf '%s\n' '-i %i -j DROP' '-i %i -p tcp -m multiport --dports 80,443 -j RETURN' '-i %i -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN')\" ]"
check "  … never prints the private key" bash -c "! grep -q 'cHJpdmF0ZWtleX' '$TMP/out' '$TMP/err'"
check "  … starts under a scheduled rollback" bash -c "grep -q 'systemd-run --quiet --unit aprscaching-net44-rollback --on-active=20s systemctl stop wg-quick@wg44' '$MOCK_LOG' && grep -q 'start wg-quick@wg44' '$MOCK_LOG'"
check "  … and with a handshake, cancels it and enables the tunnel at boot" \
  bash -c "grep -q 'stop aprscaching-net44-rollback.timer' '$MOCK_LOG' && grep -q 'enable wg-quick@wg44' '$MOCK_LOG'"
check "  … adds the 44net endpoint to FED_ENDPOINTS" eq "$(grep '^FED_ENDPOINTS=' "$ENVF")" \
  "FED_ENDPOINTS='[{\"transport\":\"https\",\"address\":\"https://aprs.example.net\",\"priority\":10},{\"transport\":\"44net\",\"address\":\"aprscaching.oe8apr.ampr.org\",\"priority\":20}]'"

: >"$MOCK_LOG"
MOCK_PMTU=1492 n44 setup --yes --non-interactive "$TMP/full.conf" --name aprscaching.oe8apr.ampr.org
check "a second run with the same configuration changes nothing" bash -c "grep -q 'nothing to change' '$TMP/out' && ! grep -q 'start wg-quick@wg44' '$MOCK_LOG'"
check "  … nor duplicates the endpoint" eq "$(grep -o '"44net"' "$ENVF" | wc -l)" 1

MOCK_PMTU=1492 n44 setup --yes --non-interactive "$TMP/full.conf" --https
check "--https serves the name over https: the endpoint becomes https://<name>" eq "$(grep '^FED_ENDPOINTS=' "$ENVF")" \
  "FED_ENDPOINTS='[{\"transport\":\"https\",\"address\":\"https://aprs.example.net\",\"priority\":10},{\"transport\":\"44net\",\"address\":\"https://aprscaching.oe8apr.ampr.org\",\"priority\":20}]'"
check "  … and the name joins EXTRA_ORIGINS" eq "$(grep '^EXTRA_ORIGINS=' "$ENVF")" "EXTRA_ORIGINS=https://aprscaching.oe8apr.ampr.org"
MOCK_PMTU=1492 n44 setup --yes --non-interactive "$TMP/full.conf" --https
check "  … once" eq "$(grep '^EXTRA_ORIGINS=' "$ENVF")" "EXTRA_ORIGINS=https://aprscaching.oe8apr.ampr.org"
cp "$ENVF" "$TMP/env.kept"
printf 'APP_URL=https://AprsCaching.oe8apr.ampr.org:443/\nDOMAIN=aprscaching.oe8apr.ampr.org\n' >"$ENVF"
MOCK_PMTU=1492 n44 setup --yes --non-interactive "$TMP/full.conf" --name aprscaching.oe8apr.ampr.org --https
check "  … but not when it is APP_URL's own address, which Caddy already serves" eq "$(grep -c '^EXTRA_ORIGINS=' "$ENVF")" 0
cp "$TMP/env.kept" "$ENVF"

rm -f "$MOCK_STATE/up"
MOCK_PMTU=1500 n44 setup --yes --non-interactive "$TMP/split.conf"
check "a split tunnel stays as issued" bash -c "! grep -q 'Table = off' '$CONF' && ! grep -q 'ip -4 rule\|CONNMARK' '$CONF' && grep -qx 'AllowedIPs = 44.0.0.0/8' '$CONF'"
check "  … and says it carries 44Net traffic only" grep -q "carries 44Net traffic only" "$TMP/out"
check "  … keeps the peer's own keepalive" bash -c "grep -c PersistentKeepalive '$CONF' | grep -qx 1 && grep -qx 'PersistentKeepalive = 15' '$CONF'"
check "  … and the MTU is capped at 1420 on a 1500 path" in_conf "MTU = 1420"

rm -f "$MOCK_STATE/up"
MOCK_PMTU=0 n44 setup --yes --non-interactive "$TMP/full.conf"
check "an endpoint that ignores pings: 1420, with advice" bash -c "grep -qx 'MTU = 1420' '$CONF' && grep -q 'does not answer pings' '$TMP/err'"
rm -f "$MOCK_STATE/up"
n44 setup --yes --non-interactive "$TMP/full.conf" --mtu 1372
check "--mtu wins" in_conf "MTU = 1372"
rm -f "$MOCK_STATE/up"
n44 setup --yes --non-interactive "$TMP/full.conf" --no-firewall
check "--no-firewall writes no firewall, and warns" bash -c "! grep -q 'nft\|DOCKER-USER' '$CONF' && grep -q 'no firewall' '$TMP/err'"

# ---- the rollback guard -------------------------------------------------------------------------------------
rm -f "$MOCK_STATE/up"
: >"$MOCK_STATE/nohandshake"
: >"$MOCK_LOG"
check "no handshake in a non-interactive run rolls back" fails n44 setup --yes --non-interactive "$TMP/full.conf" --mtu 1400
check "  … stops the tunnel and does not enable it" bash -c "grep -q 'stop wg-quick@wg44' '$MOCK_LOG' && ! grep -q 'enable wg-quick@wg44' '$MOCK_LOG' && grep -q 'Rolled back' '$TMP/err'"
rm -f "$MOCK_STATE/nohandshake"

# ---- refusals ------------------------------------------------------------------------------------------------
printf '[Interface]\nAddress = 10.0.0.2/32\nPrivateKey = x\n[Peer]\nEndpoint = a:1\nAllowedIPs = 0.0.0.0/0\n' >"$TMP/not44.conf"
check "a configuration without a 44.x address is refused" fails n44 setup --yes "$TMP/not44.conf"
check "a name outside ampr.org is refused" fails n44 setup --yes "$TMP/full.conf" --name aprs.example.net
check "the base name <call>.ampr.org is refused" fails n44 setup --yes "$TMP/full.conf" --name oe8apr.ampr.org
check "without --yes and nobody to ask, nothing changes" bash -c "rm -f '$MOCK_STATE/up'; ! '$H' --non-interactive net44 setup '$TMP/full.conf' --mtu 1300 </dev/null >/dev/null 2>&1 && ! grep -qx 'MTU = 1300' '$CONF'"

# ---- status and check -----------------------------------------------------------------------------------------
: >"$MOCK_STATE/up"
n44 status
check "status shows the address, the handshake, the routing and the firewall" bash -c "
  grep -q '44.27.132.9/32' '$TMP/out' && grep -q 'handshake: [0-9]* s ago' '$TMP/out' && grep -q 'full tunnel' '$TMP/out' &&
  grep -q 'firewall: on' '$TMP/out' && grep -q 'DOCKER-USER: filters wg44' '$TMP/out'"
check "check passes with the A record on the tunnel and the TXT record" n44 check
check "  … and prints the outside test" grep -q 'curl -fsS http://aprscaching.oe8apr.ampr.org/health' "$TMP/out"
check "an A record elsewhere fails" bash -c "MOCK_A=44.1.2.3 '$H' net44 check </dev/null 2>&1 | grep -q 'FAIL A record: 44.1.2.3, but the tunnel is 44.27.132.9'"
check "a missing TXT record fails" bash -c "! MOCK_NO_TXT=1 '$H' net44 check </dev/null >/dev/null 2>&1"
check "  … and names the records to add" bash -c "MOCK_NO_TXT=1 '$H' net44 check </dev/null 2>&1 | grep -q '_aprscaching  TXT'"
check "a verify= record is not the identity record" bash -c "! MOCK_VERIFY_ONLY=1 '$H' net44 check </dev/null >/dev/null 2>&1"

# ---- doctor's 44Net checks (the stack's own checks fail here; only these are read) -----------------------------
if command -v node >/dev/null 2>&1; then
  "$H" --json doctor </dev/null >"$TMP/doc.json" 2>/dev/null || true
  status_of() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=j.checks.find(c=>c.id===process.argv[2]);console.log(c?c.status:"absent")' "$TMP/doc.json" "$1"; }
  check "doctor: the tunnel passes" eq "$(status_of net44.tunnel)" pass
  check "doctor: the MTU passes" eq "$(status_of net44.mtu)" pass
  check "doctor: the firewall passes" eq "$(status_of net44.firewall)" pass
  check "doctor: the A record passes" eq "$(status_of net44.dns)" pass
  check "doctor: the TXT record passes" eq "$(status_of net44.txt)" pass
  check "doctor: the certificate of a name EXTRA_ORIGINS serves over https is checked" eq "$(status_of net44.cert)" warn
  rm -f "$MOCK_STATE/up"
  "$H" --json doctor </dev/null >"$TMP/doc.json" 2>/dev/null || true
  check "doctor: a configured 44net endpoint without the tunnel fails" eq "$(status_of net44.tunnel)" fail
else
  echo "skip doctor (needs Node.js to read its JSON)"
fi

# ---- remove ------------------------------------------------------------------------------------------------------
: >"$MOCK_STATE/up"
n44 remove --yes
check "remove takes the tunnel down and disables it" bash -c "grep -q 'disable --now wg-quick@wg44' '$MOCK_LOG' && [ ! -e '$MOCK_STATE/up' ]"
check "  … deletes the configuration and the firewall" bash -c "[ ! -e '$CONF' ] && [ ! -e '$APRS_NET44_DIR/wg44.nft' ]"
check "  … and with --yes the issued configuration too" test ! -e "$APRS_NET44_DIR/wg44.issued.conf"
check "  … and drops the 44net endpoint" eq "$(grep '^FED_ENDPOINTS=' "$ENVF")" \
  "FED_ENDPOINTS='[{\"transport\":\"https\",\"address\":\"https://aprs.example.net\",\"priority\":10}]'"

# ---- shapes that use an app, and shapes without 44Net ---------------------------------------------------------------
printf 'shape=pocket\nenv=%s\n' "$ENVF" >"$APRSCACHING_SHAPE_FILE"
printf 'ADMIN_CALLSIGNS=OE8APR\n' >>"$ENVF"
: >"$MOCK_LOG"
MOCK_PMTU=1492 n44 setup "$TMP/full.conf"
check "on Pocket, setup prints the app steps with the probed MTU" bash -c "grep -q 'set MTU to 1412' '$TMP/out' && grep -q 'Persistent keepalive to 25' '$TMP/out'"
check "  … and changes nothing on the host" bash -c "! grep -q 'systemctl\|systemd-run' '$MOCK_LOG'"
check "  … and sets the default Pocket name, aprscaching-pocket.<call>.ampr.org" \
  bash -c "grep -q '\"44net\",\"address\":\"aprscaching-pocket.oe8apr.ampr.org\"' '$ENVF' && grep -q '_aprscaching.aprscaching-pocket  TXT' '$TMP/out'"
printf 'shape=ingest-box\nenv=\n' >"$APRSCACHING_SHAPE_FILE"
check "an ingest box has no 44Net helper" fails n44 setup "$TMP/full.conf"

# ---- the FED_ENDPOINTS edits on their own ------------------------------------------------------------------------------
fe() { bash -c ". '$DEPLOY/lib/common.sh'; . '$DEPLOY/lib/env.sh'; . '$DEPLOY/lib/net44.sh'; \"\$@\"" _ "$@"; }
check "an existing list gets the 44net endpoint appended" eq \
  "$(fe n44_endpoints_with '[{"transport":"https","address":"https://a.example","priority":10}]' https://a.example n.oe8apr.ampr.org)" \
  '[{"transport":"https","address":"https://a.example","priority":10},{"transport":"44net","address":"n.oe8apr.ampr.org","priority":20}]'
check "an existing 44net endpoint is replaced, not added" eq \
  "$(fe n44_endpoints_with '[{"transport":"44net","address":"old.oe8apr.ampr.org","priority":20},{"transport":"https","address":"https://a.example","priority":10}]' x new.oe8apr.ampr.org)" \
  '[{"transport":"44net","address":"new.oe8apr.ampr.org","priority":20},{"transport":"https","address":"https://a.example","priority":10}]'
check "removing a leading 44net endpoint keeps the rest" eq \
  "$(fe n44_endpoints_without '[{"transport":"44net","address":"n.oe8apr.ampr.org","priority":20},{"transport":"https","address":"https://a.example","priority":10}]')" \
  '[{"transport":"https","address":"https://a.example","priority":10}]'

[ "$FAILED" -eq 0 ] && echo "all net44 checks passed"
exit "$FAILED"
