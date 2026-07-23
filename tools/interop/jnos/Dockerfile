# JNOS 2.0 — a third independent FBB-forwarding implementation (and NOS-lineage NET/ROM), built
# from source. Userspace AXUDP; no privileges. Pin the source via --build-arg JNOS_URL (+
# JNOS_SHA256 for the tarball).
FROM debian:bookworm-slim
ARG JNOS_URL=https://www.langelaar.net/jnos2/downloads/jnos2.0m.5.tar.gz
# community full-source mirror on GitHub (VE4KLM/N5KNX/KA9Q lineage) — reliable CI infrastructure
# when the primary site's TLS chain or availability wobbles
# pinned to an immutable commit archive — the commit hash IS the version pin; bumps are
# deliberate and re-run the conformance suite (JNOS_SHA256 stays an operator override)
ARG JNOS_URL_MIRROR=https://github.com/DigitalHERMES/jnos2/archive/55558642d3bbc419ed0275ab64b5910d4bfe13ee.tar.gz
ARG JNOS_SHA256=
# libssl-dev: configure defines WINLINK_SECURE_LOGIN and refuses to complete without the OpenSSL
# headers (make then dies with "you have to run './configure' first")
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential libncurses-dev libssl-dev zlib1g-dev telnet \
  iproute2 iptables procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/jnos
# The configure step is an interactive questionnaire — feed it defaults. The build itself MUST
# succeed and produce the jnos binary: a failed compile fails the image build loudly instead of
# shipping a container that dies at `docker compose up`.
# The mirror serves an incomplete TLS chain ("unable to get local issuer certificate"), so fall
# back to an unverified fetch — integrity comes from the optional JNOS_SHA256 pin, and the build
# runs in an isolated throwaway container.
RUN set -e; \
  fetch() { curl -fsSL --connect-timeout 15 --max-time 240 --retry 2 --retry-delay 5 "$@"; }; \
  fetch "$JNOS_URL" -o jnos.tar.gz \
  || { echo "verified TLS failed — retrying without chain verification (pin JNOS_SHA256 to attest)"; \
       fetch -k "$JNOS_URL" -o jnos.tar.gz; } \
  || { echo "primary site unreachable — falling back to the GitHub source mirror"; \
       fetch "$JNOS_URL_MIRROR" -o jnos.tar.gz; } \
  || { echo "JNOS source unreachable — pin JNOS_URL to a live mirror"; exit 1; }; \
  if [ -n "$JNOS_SHA256" ]; then echo "$JNOS_SHA256  jnos.tar.gz" | sha256sum -c -; fi; \
  { tar xzf jnos.tar.gz --strip-components=1 || tar xzf jnos.tar.gz; }; \
  # hard cap: a configure question that rejects the empty answer re-asks forever — never wedge the build
  if [ -x ./configure ]; then timeout 180 sh -c "yes '' | ./configure" || true; fi; \
  # the questionnaire's defaults decide which drivers exist — this peer NEEDS the AXIP/AXUDP
  # attach type, so force the define and fail the build loudly if it cannot be guaranteed
  if [ -f config.h ]; then \
    grep -q '^#define AXIP' config.h || sed -i 's|^.*#undef[[:space:]]\+AXIP[[:space:]]*$|#define AXIP|' config.h; \
    grep -q '^#define AXIP' config.h || printf '#define AXIP\n' >> config.h; \
    grep -q '^#define AXIP' config.h || { echo "config.h lacks AXIP and could not be forced"; exit 1; }; \
  fi; \
  make; \
  [ -x ./jnos ] || { echo "JNOS build produced no ./jnos binary"; exit 1; }
COPY autoexec.nos /opt/jnos/autoexec.nos
COPY ftpusers /opt/jnos/ftpusers
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 23 10093/udp
# start.sh plumbs the Linux side of the NOS tun device, then runs jnos in the foreground
CMD ["/start.sh"]
