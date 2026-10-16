#!/bin/sh
# One Direwolf with a userspace audio cable to its peer: the modem's transmit audio goes to ALSA's
# `file` plugin, which pipes the raw 16-bit samples to socat, which sends them as UDP datagrams to the
# peer Direwolf, which reads its receive audio with `ADEVICE udp:7355`. Two of these, each pointing at
# the other, are a full-duplex audio loopback between two real Bell-202 modems. PEER_PORT (default 7355) is the
# UDP port the peer listens on: the ingest's soundcard port on the host takes the place of a peer Direwolf.
# TXMODE picks what this Direwolf transmits: ax25 (default), fx25 (FX25TX 16) or il2p (IL2PTX 1); it receives
# all three either way.
#
# The kernel's snd-aloop would do the same through ALSA, but it needs a module the hosted runners load
# only after installing linux-modules-extra for the running kernel, plus a privileged or device-mapped
# container. The UDP cable needs neither: it runs unprivileged wherever Docker runs, the same on a
# laptop as in CI. The modem path is unchanged — Direwolf's own modulator writes the samples and its
# own demodulator decodes them; only the cable is a datagram.
set -eu
: "${MYCALL:?MYCALL is required}"
: "${PEER:?PEER (the other Direwolf host) is required}"
PEER_PORT="${PEER_PORT:-7355}"
case "${TXMODE:-ax25}" in
  ax25) FEC="" ;;
  fx25) FEC="FX25TX 16" ;;
  il2p) FEC="IL2PTX 1" ;;
  *) echo "TXMODE must be ax25, fx25 or il2p" >&2; exit 1 ;;
esac

# `tx` attenuates to a quarter, the receive level Direwolf asks for (about 50 rather than 200 at full
# scale), then hands the samples to the cable. socat sends 1024-byte datagrams because Direwolf reads at
# most 2000 bytes of each one and drops the rest; it is restarted after an error, so a peer that comes
# up later is reached once its name resolves.
cat > "$HOME/.asoundrc" <<CONF
pcm.tx {
  type route
  slave.pcm "cable"
  ttable.0.0 0.25
}
pcm.cable {
  type file
  slave.pcm "null"
  file "|while :; do socat -u -b 1024 - UDP-SENDTO:${PEER}:${PEER_PORT}; sleep 1; done"
  format "raw"
}
CONF

cat > "$HOME/direwolf.conf" <<CONF
ADEVICE udp:7355 tx
ARATE 48000
ACHANNELS 1
CHANNEL 0
MYCALL ${MYCALL}
MODEM 1200
${FEC}
# full duplex: each direction has its own audio path, so never wait for a clear channel
FULLDUP ON
TXDELAY 30
TXTAIL 10
AGWPORT 8000
KISSPORT 8001
CONF

exec direwolf -t 0 -c "$HOME/direwolf.conf"
