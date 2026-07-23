# F6FBB (LinFBB) — the reference FBB implementation, from the Ubuntu archive. Two access paths:
#  - telnet :6300 (Interface 9, hex 189C): console/driver access and telnet forwarding partners.
#  - kernel AX.25 bridged to AXUDP by ax25ipd: REQUIRES the ax25 module on the HOST
#    (sudo modprobe ax25) and a privileged container.
FROM ubuntu:noble
RUN apt-get update && apt-get install -y --no-install-recommends fbb ax25-tools ax25-apps telnet \
  && rm -rf /var/lib/apt/lists/*
COPY fbb.conf port.sys /etc/ax25/fbb/
COPY axports ax25ipd.conf /etc/ax25/
COPY start.sh /start.sh
RUN chmod +x /start.sh \
  && mkdir -p /var/ax25/fbb/mail /var/ax25/fbb/binmail /var/ax25/fbb/fbbdos/yapp \
     /var/ax25/fbb/docs /var/ax25/fbb/log /var/ax25/fbb/oldmail /var/ax25/fbb/sat \
  && touch /var/ax25/fbb/sat/satel.dat
EXPOSE 6300 10093/udp
CMD ["/start.sh"]
