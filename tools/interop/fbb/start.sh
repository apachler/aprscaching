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
exec /usr/sbin/xfbbd -s </dev/null
