#!/bin/bash
# Bring up the kernel AX.25 port behind KISS TCP:
#   kissnetd ── pty 1: kissattach (the kernel's mkiss line discipline, port "kern", OE9KRN-1)
#            ├─ pty 2: socat ⇄ TCP :8001 (our KISS TCP client)
#            └─ pty 3: axkit tap → /tmp/tap.log (every frame as it crossed the wire)
# plus axkit mon → /tmp/mon.log (every frame the kernel decoded or sent) and ax25d serving OE9KRN-2.
# Readiness: /tmp/ready exists once all of it is up.
set -euo pipefail
if [ ! -e /proc/net/ax25 ]; then
  echo "[ax25kernel] no kernel AX.25 — load it on the host first: sudo modprobe ax25 mkiss" >&2
  exit 1
fi

stdbuf -oL kissnetd -p 3 >/tmp/kissnetd.log 2>&1 &
for _ in $(seq 1 20); do grep -q '^/dev/pts' /tmp/kissnetd.log && break; sleep 0.5; done
read -r KERN TCP TAP < <(grep '^/dev/pts' /tmp/kissnetd.log)
echo "[ax25kernel] kissnetd ptys: kernel=$KERN tcp=$TCP tap=$TAP"

# A pty slave echoes what it receives unless it is raw; an echo would loop frames back into kissnetd.
stty -F "$TCP" raw -echo
stty -F "$TAP" raw -echo
# kissnetd stops serving a pty whose slave closes, so hold the TCP side open across client reconnects.
sleep infinity <"$TCP" &
axkit tap "$TAP" /tmp/tap.log &

# kissattach holds the pty for as long as the port lives; it runs in the background and the device it
# creates is found in sysfs.
kissattach "$KERN" kern >/tmp/kissattach.log 2>&1 &
DEV=""
for _ in $(seq 1 20); do
  DEV=$(ls /sys/class/net | grep '^ax' | head -1 || true)
  [ -n "$DEV" ] && break
  sleep 0.5
done
cat /tmp/kissattach.log
[ -n "$DEV" ] || { echo "[ax25kernel] kissattach created no AX.25 device" >&2; exit 1; }
echo "$DEV" >/tmp/dev
axkit mon "$DEV" /tmp/mon.log &
ax25d -l &
# kissnetd stops relaying to a pty whose slave was not yet open when it first read it, and retries such a
# pty only after 30 idle seconds; every slave is open now, so the first retry brings all three in.
sleep 32
echo "[ax25kernel] kernel AX.25 port kern on $DEV, ax25d up, KISS TCP on :8001"
touch /tmp/ready
while :; do socat TCP-LISTEN:8001,reuseaddr "FILE:$TCP,raw,echo=0" || sleep 1; done
