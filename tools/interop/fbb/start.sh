#!/usr/bin/env sh
# Bring up kernel AX.25 bridged to AXUDP, then xfbbd:
#   kissattach puts the kernel's mkiss line discipline on a pty (port "axudp", OE9FBB-1), and ax25ipd
#   carries that pty's KISS frames as AXUDP on udp :10093.
# The kernel path is required: without it the container exits, so a run cannot pass on telnet alone.
# FBB_TELNET_ONLY=1 skips it on a host without the ax25 and mkiss modules, and the log says so.
set -u
if [ "${FBB_TELNET_ONLY:-}" = "1" ]; then
  echo "[fbb] FBB_TELNET_ONLY=1 — kernel AX.25 skipped, telnet only"
else
  if [ ! -e /proc/net/ax25 ]; then
    echo "[fbb] no kernel AX.25 — load it on the host first: sudo bash tools/interop/ax25kernel/load-modules.sh" >&2
    exit 1
  fi
  # kissattach on /dev/ptmx holds the master and prints the slave it allocated; ax25ipd opens that slave
  kissattach /dev/ptmx axudp >/tmp/kissattach.log 2>&1 &
  PTS=""
  for _ in $(seq 1 20); do
    PTS=$(grep -o '/dev/pts/[0-9]*' /tmp/kissattach.log | head -1)
    [ -n "$PTS" ] && break
    sleep 0.5
  done
  cat /tmp/kissattach.log
  DEV=$(ls /sys/class/net | grep '^ax' | head -1)
  if [ -z "$PTS" ] || [ -z "$DEV" ]; then
    echo "[fbb] kissattach attached no AX.25 device (is mkiss loaded on the host?)" >&2
    exit 1
  fi
  # a pty slave echoes what it receives unless it is raw; an echo would loop frames back into the kernel
  stty -F "$PTS" raw -echo
  sed "s|^device .*|device $PTS|" /etc/ax25/ax25ipd.conf >/tmp/ax25ipd.conf
  ax25ipd -c /tmp/ax25ipd.conf >/tmp/ax25ipd.log 2>&1 &
  sleep 1
  if ! pgrep -x ax25ipd >/dev/null; then
    cat /tmp/ax25ipd.log
    echo "[fbb] ax25ipd did not start" >&2
    exit 1
  fi
  echo "[fbb] kernel AX.25 port axudp on $DEV ($PTS), ax25ipd bridging it to AXUDP :10093"
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
