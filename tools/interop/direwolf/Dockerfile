# Direwolf (WB2OSZ) — the soundcard AFSK modem real stations run, from Ubuntu's archive (GPL-2,
# installed at build, never vendored). Two instances of this image modulate and demodulate Bell-202
# 1200 bd AFSK at each other; start.sh wires the audio path.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update && apt-get install -y --no-install-recommends direwolf socat \
  && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh && useradd --create-home dw
# Direwolf needs no privileges, and warns when it runs as root
USER dw
WORKDIR /home/dw
EXPOSE 8000 8001 7355/udp
CMD ["/start.sh"]
