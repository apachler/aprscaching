#!/usr/bin/env bash
# Fixture tests for the 44Net pieces of Pocket: the 44Net address found in `ip` output, ampr.org host
# names, the certificate expiry check, and extras/ampr-cert.sh end to end with a fake lego (the ACME
# client) and a fake DNS-over-HTTPS answer. Runs anywhere with bash, openssl and node; no Termux.
#
#   bash deploy/pocket/test/net44-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  FAILS=$((FAILS + 1))
}
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$3', got '$2'"; fi; }
yes_no() { if "$@"; then echo yes; else echo no; fi; }

BIN="$WORK/bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"
# shellcheck source=deploy/pocket/lib.sh
. "$ROOT/deploy/pocket/lib.sh"

# ---- the 44Net address, from `ip -4 -o addr show` -----------------------------------------------------
fake_ip() {
  printf '%s\n' "$@" >"$WORK/ip.out"
  cat >"$BIN/ip" <<EOF
#!/usr/bin/env bash
cat "$WORK/ip.out"
EOF
  chmod +x "$BIN/ip"
}
fake_ip "1: lo    inet 127.0.0.1/8 scope host lo" \
  "30: wlan0    inet 192.168.43.1/24 brd 192.168.43.255 scope global wlan0" \
  "41: tun0    inet 44.27.132.9/32 scope global tun0"
check "44Net: the tunnel address" "$(net44_address)" "tun0 44.27.132.9"
fake_ip "1: lo    inet 127.0.0.1/8 scope host lo" "40: tun0    inet 44.135.208.1/32 scope global tun0"
check "44Net: 44.128.0.0/10 counts" "$(net44_address)" "tun0 44.135.208.1"
fake_ip "1: lo    inet 127.0.0.1/8 scope host lo" "40: tun0    inet 44.200.1.2/32 scope global tun0"
check "44Net: 44.192.0.0/10 is not 44Net" "$(yes_no net44_address)" no
fake_ip "1: lo    inet 127.0.0.1/8 scope host lo" "30: wlan0    inet 10.44.0.5/24 scope global wlan0"
check "44Net: none without a 44.x address" "$(yes_no net44_address)" no

# ---- the HAMNET endpoint: what FED_ENDPOINTS declares, never inferred from an address ------------------
ENV_FILE="$WORK/hamnet.env"
printf '%s\n' "FED_ENDPOINTS='[{\"transport\":\"https\",\"address\":\"https://p.example\",\"priority\":10},{\"transport\":\"hamnet\",\"address\":\"44.143.1.2:8080\",\"priority\":30}]'" >"$ENV_FILE"
check "HAMNET: the declared endpoint" "$(hamnet_endpoint)" "44.143.1.2:8080"
printf '%s\n' "FED_ENDPOINTS='[{\"transport\":\"44net\",\"address\":\"pocket.oe8apr.ampr.org\",\"priority\":10}]'" >"$ENV_FILE"
check "HAMNET: none without a hamnet endpoint" "$(hamnet_endpoint)" ""

# ---- ampr.org host names -----------------------------------------------------------------------------
check "host: <call>.ampr.org" "$(yes_no valid_ampr_host oe8apr.ampr.org)" yes
check "host: a name under it" "$(yes_no valid_ampr_host aprscaching-pocket.oe8apr.ampr.org)" yes
check "host: another zone" "$(yes_no valid_ampr_host oe8apr.example.org)" no
check "host: ampr.org itself" "$(yes_no valid_ampr_host ampr.org)" no
check "host: uppercase" "$(yes_no valid_ampr_host OE8APR.ampr.org)" no
check "host: empty label" "$(yes_no valid_ampr_host a..ampr.org)" no
check "host: leading hyphen" "$(yes_no valid_ampr_host -x.ampr.org)" no

# ---- certificate expiry ------------------------------------------------------------------------------
cert() { openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" -days "$2" \
  -keyout "$3.key" -out "$3.crt" >/dev/null 2>&1; }
cert soon.ampr.org 5 "$WORK/soon"
cert later.ampr.org 60 "$WORK/later"
check "expiry: 5 days left is within 14" "$(yes_no cert_expires_within "$WORK/soon.crt" 14)" yes
check "expiry: 60 days left is not" "$(yes_no cert_expires_within "$WORK/later.crt" 14)" no

# ---- ampr-cert.sh with a fake lego and a fake DNS ----------------------------------------------------
DATA="$WORK/data"
mkdir -p "$DATA"
cp "$ROOT/deploy/pocket/.env.pocket.example" "$DATA/.env"
printf 'TLS_CA_CERT=%s/tls/ca.crt\n' "$DATA" >>"$DATA/.env"
# lego: prints the manual-mode prompt, waits for Enter, then stores a certificate where lego keeps it.
cat >"$BIN/lego" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >"$WORK/lego.args"
path="" domain=""
while [ \$# -gt 0 ]; do
  case "\$1" in --path) path="\$2"; shift ;; --domains) domain="\$2"; shift ;; esac
  shift
done
echo "Please create the following TXT record in your ampr.org. zone:"
echo "_acme-challenge.\$domain. 120 IN TXT \"tok-4Xy_z\""
printf "Press 'Enter' once the record is available."
IFS= read -r _ || exit 9
echo
echo "Server responded with a certificate."
mkdir -p "\$path/certificates"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=\$domain" -days 90 \
  -keyout "\$path/certificates/\$domain.key" -out "\$path/certificates/\$domain.crt" >/dev/null 2>&1
EOF
# curl: the DNS-over-HTTPS answer carries the record from the third lookup on.
cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
n=\$(( \$(cat "$WORK/dns.n" 2>/dev/null || echo 0) + 1 ))
echo "\$n" >"$WORK/dns.n"
printf '%s\n' "\$*" >>"$WORK/dns.queries"
if [ "\$n" -ge 3 ] && [ -z "\${DNS_NEVER:-}" ]; then
  echo '{"Status":0,"Answer":[{"name":"_acme-challenge.oe8apr.ampr.org.","type":16,"data":"\"tok-4Xy_z\""}]}'
else
  echo '{"Status":3}'
fi
EOF
chmod +x "$BIN/lego" "$BIN/curl"
CERT_SH="$ROOT/deploy/pocket/extras/ampr-cert.sh"
export APRSCACHING_ACME_POLL_S=0

OUT="$(bash "$CERT_SH" --host OE8APR.ampr.org. --use --data-dir "$DATA" 2>&1)" || fail "ampr-cert: exit status: $OUT"
case "$OUT" in *"name:   _acme-challenge.oe8apr.ampr.org"*"value:  tok-4Xy_z"*) pass "ampr-cert: prints the record" ;; *) fail "ampr-cert: record not printed: $OUT" ;; esac
check "ampr-cert: waits until DNS answers" "$(cat "$WORK/dns.n")" 3
case "$(cat "$WORK/dns.queries")" in *"name=_acme-challenge.oe8apr.ampr.org&type=TXT"*) pass "ampr-cert: asks for the TXT record" ;; *) fail "ampr-cert: query" ;; esac
case "$(cat "$WORK/lego.args")" in *"run --accept-tos --domains oe8apr.ampr.org --dns manual"*) pass "ampr-cert: lego run, manual DNS-01" ;; *) fail "ampr-cert: lego args $(cat "$WORK/lego.args")" ;; esac
check "ampr-cert: the certificate copied" "$(openssl x509 -noout -subject -in "$DATA/tls/ampr.crt" | sed 's/.*CN *= *//')" oe8apr.ampr.org
check "ampr-cert: the key private" "$(stat -c %a "$DATA/tls/ampr.key")" 600
check "ampr-cert: the host remembered" "$(cat "$DATA/tls/ampr.host")" oe8apr.ampr.org
ENV_FILE="$DATA/.env"
check "--use: TLS_CERT" "$(env_get TLS_CERT)" "$DATA/tls/ampr.crt"
check "--use: TLS_KEY" "$(env_get TLS_KEY)" "$DATA/tls/ampr.key"
check "--use: HTTPS_PORT" "$(env_get HTTPS_PORT)" 8443
check "--use: the station CA is not served" "$(env_get TLS_CA_CERT)" ""

rm -f "$WORK/dns.n"
status=0
OUT="$(DNS_NEVER=1 bash "$CERT_SH" --host oe8apr.ampr.org --wait-min 0 --data-dir "$DATA" 2>&1)" || status=$?
check "ampr-cert: gives up when the record never appears" "$status" 1
case "$OUT" in *"did not appear in DNS"*) pass "ampr-cert: says why" ;; *) fail "ampr-cert: no reason: $OUT" ;; esac
sleep 0.5
check "ampr-cert: lego stopped" "$(pgrep -f "$BIN/lego" >/dev/null && echo running || echo stopped)" stopped

status=0
OUT="$(bash "$CERT_SH" --host oe8apr.example.org --data-dir "$DATA" 2>&1)" || status=$?
check "ampr-cert: refuses a name outside ampr.org" "$status" 1

if [ "$FAILS" -gt 0 ]; then
  printf '\n%s check(s) failed\n' "$FAILS"
  exit 1
fi
printf '\nall 44Net checks passed\n'
