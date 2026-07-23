# LinBPQ (G8BPQ) — userspace node + BBS speaking NET/ROM and FBB forwarding over its AXIP/AXUDP
# driver. Primary source: the community Hibbian apt repository (guide.hibbian.org) — the repo is
# the distributor and ships a native build. Fallback: the author's direct download (freeware for
# amateur use, never redistributed by this repo), which is a 32-bit x86 binary needing the i386
# loader. Pin the fallback via --build-arg LINBPQ_URL / LINBPQ_SHA256.
FROM debian:bookworm-slim
ARG LINBPQ_URL=https://www.cantab.net/users/john.wiseman/Downloads/Beta/linbpq
ARG LINBPQ_SHA256=
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg telnet \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/bpq
RUN set -e; \
  if curl -fsSL --connect-timeout 15 --max-time 120 https://guide.hibbian.org/static/files/setup.sh -o /tmp/hibbian.sh \
    && sed -i 's/\bsudo \b//g' /tmp/hibbian.sh \
    && bash /tmp/hibbian.sh \
    && apt-get update && apt-get install -y --no-install-recommends linbpq \
    && command -v linbpq >/dev/null; then \
    echo "linbpq installed from the Hibbian apt repository"; \
  else \
    echo "Hibbian repo unavailable — falling back to the direct download"; \
    dpkg --add-architecture i386; \
    apt-get update && apt-get install -y --no-install-recommends libc6:i386 libgcc-s1:i386 zlib1g:i386; \
    curl -fsSL --connect-timeout 15 --max-time 240 --retry 3 --retry-delay 5 "$LINBPQ_URL" -o /usr/local/bin/linbpq; \
    if [ -n "$LINBPQ_SHA256" ]; then echo "$LINBPQ_SHA256  /usr/local/bin/linbpq" | sha256sum -c -; fi; \
    magic="$(od -An -tx1 -N4 /usr/local/bin/linbpq | tr -d ' ')"; \
    [ "$magic" = "7f454c46" ] || { echo "linbpq download is not an ELF binary (magic $magic) — pin LINBPQ_URL"; exit 1; }; \
    chmod +x /usr/local/bin/linbpq; \
  fi; \
  rm -rf /var/lib/apt/lists/*
# the binary reads bpq32.cfg from the working directory; the packaged build also looks in /etc
COPY bpq32.cfg /opt/bpq/bpq32.cfg
COPY bpq32.cfg /etc/bpq32.cfg
EXPOSE 8008 8010 10093/udp
CMD ["linbpq"]
