#!/usr/bin/env sh
# Bring up kernel AX.25 (if the host lends us the module) bridged to AXUDP, then xfbbd.
# Without kernel AX.25 the telnet port still serves (fallback validated in the sandbox runbook).
set -u
if [ -e /proc/net/ax25 ] || modprobe ax25 2>/dev/null; then
  kissattach -l /dev/ptmx axudp 44.128.0.2 >/tmp/kissattach.log 2>&1 || true
  ax25ipd -c /etc/ax25/ax25ipd.conf >/tmp/ax25ipd.log 2>&1 &
  echo "[fbb] kernel AX.25 + ax25ipd up"
else
  echo "[fbb] no kernel AX.25 (host modprobe ax25 missing) — telnet-only mode"
fi
# first run: answer the interactive data-file creation prompts, then serve
yes Y | timeout 20 /usr/sbin/xfbbd -s >/tmp/xfbbd-init.log 2>&1
/usr/sbin/xfbbd -s </dev/null &
pid=$!
trap 'kill $pid 2>/dev/null' TERM INT

# Register the telnet users through the xfbbC sysop console, once per data volume. FBB's telnet
# gate admits only known callsigns with modem access (flag M) and a password (W):
#   OE1TST — the sysop (fbb.conf), a plain mailbox user: the addressee the forward test reads as
#   OE1ACS — the aprscaching forwarding partner: flag B, so FBB answers it as a BBS (SID + FBB protocol)
# The console callsign is created on connect, so EU on OE1TST first answers "Delete? N"; EU on the
# unknown OE1ACS first answers "Create? Y". Each answer waits for the console to settle.
if [ ! -e /var/ax25/fbb/.registered ]; then
  sleep 5 # xfbbd opens its console port once the data files are loaded
  {
    sleep 3
    for line in "EU OE1TST" N "M ON" "W ${FBB_USER_PASS:-interop2}" "" \
      "EU OE1ACS" Y "B ON" "M ON" "W ${FBB_PARTNER_PASS:-interop1}" "" "DB"; do
      printf '%s\n' "$line"
      sleep 1
    done
    sleep 2
  } | timeout 30 xfbbC -c -r -i OE1TST -w password 2>&1 | tr '\r' '\n' | grep -E '^OE1(TST|ACS)-0 '
  touch /var/ax25/fbb/.registered
  echo "[fbb] OE1TST + OE1ACS registered through xfbbC"
fi
wait $pid
