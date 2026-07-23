#!/bin/sh
# JNOS transmits through its OWN IP stack via the tun device its autoexec attaches. This side
# configures the Linux end once the device appears and masquerades JNOS's datagrams out to the
# compose network (172.31.94.2 is the NOS end, .1 the container end).
(
  i=0
  while ! ip link show tun0 >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && exit 0
    sleep 1
  done
  ip addr add 172.31.94.1/30 dev tun0
  ip link set tun0 up
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
) &
exec /opt/jnos/jnos -d /opt/jnos
