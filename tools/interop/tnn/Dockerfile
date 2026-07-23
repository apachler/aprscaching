# TheNetNode (TNN) — the TheNet-lineage NET/ROM node with its AXIP/AXUDP L2 driver (axipx).
# Source: the community GitHub mirror of TNN 1.79 (the CB build of the same NORD><LINK codebase —
# identical L2/L3 wire behaviour, which is what this environment asserts). The classic ham tarball
# (dl5mcg.de) stays a --build-arg override; its TLS stack predates OpenSSL 3 defaults, so the
# fetch ladder keeps a relaxed-handshake attempt for that override. Userspace only, no privileges.
FROM debian:bookworm-slim
# pinned to an immutable commit archive — the commit hash IS the version pin; bumps are
# deliberate and re-run the conformance suite (TNN_SHA256 stays an operator override)
ARG TNN_URL=https://github.com/DeltaLima/TheNetNode-CB/archive/b9f6bc2d5bd2ce8a08d318d795a6466d2aa6b13f.tar.gz
ARG TNN_SHA256=
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential telnet \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tnn
RUN set -e; \
  fetch() { curl -fsSL --connect-timeout 15 --max-time 240 --retry 2 --retry-delay 5 "$@"; }; \
  fetch "$TNN_URL" -o tnn.tar.gz \
  || fetch -k --tlsv1.0 --ciphers 'DEFAULT@SECLEVEL=0' "$TNN_URL" -o tnn.tar.gz \
  || { echo "TNN source unreachable — pin TNN_URL to a live mirror"; exit 1; }; \
  if [ -n "$TNN_SHA256" ]; then echo "$TNN_SHA256  tnn.tar.gz" | sha256sum -c -; fi; \
  tar xzf tnn.tar.gz --strip-components=1; \
  # -fcommon: the codebase declares variables in headers without extern — pre-gcc-10 common
  # symbols the modern linker otherwise rejects as multiple definitions
  make CC='gcc -fcommon'; \
  [ -x bin/tnn ] || { echo "TNN build produced no bin/tnn binary"; exit 1; }
# configuration set (all read from the working directory):
#   tnn.ini      — L1 device table (AX25IP driver + telnet console)
#   ax25ip.cfg   — AXIP/AXUDP socket + routes toward the acs container
#   tnn179.pas   — passwords, node ident TNN, callsign OE9TNN, path set
#   tnn179.tnb   — startup console batch (port names, parameter tuning)
COPY tnn.ini ax25ip.cfg tnn179.pas tnn179.tnb /opt/tnn/
# the code composes config names with upper-case suffixes (.PAS/.TNB) — cover both casings,
# and create the directories the PAS path set points at
RUN set -e; \
  for f in pas tnb; do \
    cp "/opt/tnn/tnn179.$f" "/opt/tnn/TNN179.$(echo $f | tr a-z A-Z)"; \
    cp "/opt/tnn/tnn179.$f" "/opt/tnn/tnn179.$(echo $f | tr a-z A-Z)"; \
    cp "/opt/tnn/tnn179.$f" "/opt/tnn/TNN179.$f"; \
  done; \
  mkdir -p /opt/tnn/textcmd /opt/tnn/userexe /opt/tnn/sysexe /opt/tnn/pacsat /opt/tnn/html /opt/tnn/msg
ENV SHELL=/bin/sh
EXPOSE 4711 10093/udp
# tnn reads its config set from the working directory; -v logs verbosely for the CI diagnostics
CMD ["/opt/tnn/bin/tnn", "-v"]
