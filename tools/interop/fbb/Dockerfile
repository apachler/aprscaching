# F6FBB (LinFBB) — the reference FBB implementation, from the Ubuntu archive. Two access paths:
#  - telnet :6300 (Interface 9, hex 189C): console/driver access and telnet forwarding partners.
#  - kernel AX.25 bridged to AXUDP by ax25ipd: REQUIRES the ax25 and mkiss modules on the HOST
#    (tools/interop/ax25kernel/load-modules.sh), a privileged container and the host network.
FROM ubuntu:noble
RUN apt-get update && apt-get install -y --no-install-recommends fbb ax25-tools ax25-apps telnet procps \
  && rm -rf /var/lib/apt/lists/*
COPY fbb.conf port.sys forward.sys /etc/ax25/fbb/
COPY axports ax25ipd.conf /etc/ax25/
COPY start.sh /start.sh
# bbs.sys numbers the forwarding partners (its line count is fixed): OE1ACS takes slot 02
RUN chmod +x /start.sh \
  && sed -i 's/^02 *$/02 OE1ACS/' /etc/ax25/fbb/bbs.sys \
  && mkdir -p /var/ax25/fbb/mail /var/ax25/fbb/binmail /var/ax25/fbb/fbbdos/yapp \
     /var/ax25/fbb/docs /var/ax25/fbb/log /var/ax25/fbb/oldmail /var/ax25/fbb/sat \
  && touch /var/ax25/fbb/sat/satel.dat
EXPOSE 6300 10093/udp
CMD ["/start.sh"]
