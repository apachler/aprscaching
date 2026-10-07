# The kernel Linux AX.25 stack as a KISS TCP peer. kissnetd joins three pseudo-ttys: kissattach puts the
# kernel's mkiss line discipline on one, socat bridges one to TCP :8001 (where our KISS TCP client
# connects), and axkit taps the third to log every frame on the wire. ax25d answers connects to OE9KRN-2.
# REQUIRES the ax25 and mkiss modules on the HOST (sudo modprobe ax25 mkiss), a privileged container and
# the host network: AF_AX25 sockets and AX.25 devices exist only in the initial network namespace.
FROM ubuntu:noble@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
  && rm -rf /var/lib/apt/lists/*
COPY axkit.c /src/axkit.c
RUN gcc -O2 -Wall -Wextra -Werror -o /axkit /src/axkit.c

FROM ubuntu:noble@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update && apt-get install -y --no-install-recommends ax25-tools ax25-apps socat kmod iproute2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /axkit /usr/local/bin/axkit
COPY axports ax25d.conf /etc/ax25/
COPY echo-svc start.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/echo-svc /usr/local/bin/start.sh
EXPOSE 8001
CMD ["/usr/local/bin/start.sh"]
