# Direwolf (WB2OSZ) — the soundcard AFSK modem real stations run, from Ubuntu's archive (GPL-2,
# installed at build, never vendored). Two instances of this image modulate and demodulate Bell-202
# 1200 bd AFSK at each other; start.sh wires the audio path.
FROM ubuntu:24.10@sha256:cdf755952ed117f6126ff4e65810bf93767d4c38f5c7185b50ec1f1078b464cc
RUN apt-get update && apt-get install -y --no-install-recommends direwolf socat \
  && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh && useradd --create-home dw
# Direwolf needs no privileges, and warns when it runs as root
USER dw
WORKDIR /home/dw
EXPOSE 8000 8001 7355/udp
CMD ["/start.sh"]
