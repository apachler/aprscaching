#!/usr/bin/env bash
# Load the kernel AX.25 stack and its KISS line discipline (mkiss) on the HOST, for the ax25kernel
# container. ax25 ships in linux-modules-extra; a kernel built without mkiss (CONFIG_MKISS unset, as on the
# Azure kernels GitHub's runners boot) gets it built out of tree from the upstream source of its version,
# against the running kernel's headers. Needs root.
set -euo pipefail
KREL=$(uname -r)
apt-get install -y "linux-modules-extra-$KREL" || true
modprobe ax25
if modprobe mkiss 2>/dev/null; then
  echo "[modules] ax25 + mkiss loaded from the distribution"
  exit 0
fi
apt-get install -y "linux-headers-$KREL" build-essential curl
modprobe crc16 2>/dev/null || true # SMACK CRC; built in on most kernels
VER=$(echo "$KREL" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')
WORK=$(mktemp -d)
curl -fsSL "https://raw.githubusercontent.com/torvalds/linux/v$VER/drivers/net/hamradio/mkiss.c" -o "$WORK/mkiss.c"
echo 'obj-m := mkiss.o' >"$WORK/Makefile"
make -C "/lib/modules/$KREL/build" M="$WORK" modules
insmod "$WORK/mkiss.ko"
echo "[modules] ax25 loaded, mkiss built from Linux v$VER and inserted"
