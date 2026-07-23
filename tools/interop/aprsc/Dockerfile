# aprsc (OH7LZB/hessu) — the core APRS-IS server the real network runs on. Built from the GitHub
# release tarball; the interop environment points the acs ingest's APRS-IS client at it, so the
# login/filter/stream protocol is exercised against the reference implementation.
FROM debian:bookworm-slim
ARG APRSC_URL=https://github.com/hessu/aprsc/archive/refs/tags/release/2.1.15.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential libevent-dev libssl-dev telnet \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL --connect-timeout 15 --max-time 240 --retry 3 --retry-delay 5 "$APRSC_URL" -o aprsc.tar.gz \
  && tar xzf aprsc.tar.gz --strip-components=1 \
  && cd src && ./configure && make -j2 && make install
# aprsc chroots into its base directory and drops to this user
RUN adduser --system --group --no-create-home aprsc \
  && mkdir -p /opt/aprsc/etc /opt/aprsc/logs /opt/aprsc/data /opt/aprsc/web \
  && chown -R aprsc:aprsc /opt/aprsc/logs /opt/aprsc/data /opt/aprsc/web
COPY aprsc.conf /opt/aprsc/etc/aprsc.conf
# aprsc resolves -c/-r relative to its base directory — run from there
WORKDIR /opt/aprsc
EXPOSE 14580 10152
CMD ["/opt/aprsc/sbin/aprsc", "-u", "aprsc", "-e", "info", "-o", "file", "-r", "logs", "-c", "etc/aprsc.conf"]
