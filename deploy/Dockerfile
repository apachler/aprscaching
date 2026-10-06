# syntax=docker/dockerfile:1
# Multi-arch (amd64 + arm64) image for the Node gateway + ingest + built SPA.
# Build context = repo root:  docker build -f deploy/Dockerfile -t aprscaching:local ..
# Node 24 matches CI (the repo's engines field requires >=22); corepack activates the exact pnpm
# pinned in package.json ("packageManager"), so image builds use the same toolchain as CI.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# pnpm is fetched into a shared COREPACK_HOME at build time, so the unprivileged user runs it without a
# writable home cache and a container starts without network access.
ENV NODE_ENV=production COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --from=build /app /app
# The services run as the unprivileged user aprscaching (UID and GID 10001), never as root. The code under
# /app stays root-owned and read-only to it. /data (the database, the generated secrets, the media, backup
# staging) and /srv/web (the SPA copy Caddy serves) belong to it, so a fresh named volume mounted there takes
# that owner; a bind-mounted host directory needs `chown -R 10001:10001` once. The user is in `dialout`
# (GID 20 on Debian, Ubuntu and Raspberry Pi OS), so a serial TNC or PTT passed in with `devices:` opens, and in
# `audio`, for a sound card. The ingest's soundcard port runs ALSA's arecord and aplay (alsa-utils) and keys a GPIO
# PTT with libgpiod's gpioset (gpiod).
RUN apt-get update && apt-get install -y --no-install-recommends alsa-utils gpiod \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack install \
 && groupadd --system --gid 10001 aprscaching \
 && useradd --system --uid 10001 --gid 10001 --groups dialout,audio --create-home --home-dir /home/aprscaching \
      --shell /usr/sbin/nologin aprscaching \
 && mkdir -p /data/media /srv/web \
 && chown -R 10001:10001 /data /srv/web
USER 10001
EXPOSE 8080
# Default = gateway; compose overrides `command:` for the ingest. The built SPA sits at
# /app/apps/web/dist — the compose `webdist` one-shot copies it into the volume Caddy serves.
# The commit the image was built from, for the AGPL §13 source link: .git stays out of the build context,
# so the host passes it in (compose reads SOURCE_COMMIT). Last, so a new commit rebuilds only this layer;
# a SOURCE_COMMIT in .env still overrides it at runtime.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
# node itself (the shell execs it), so `docker run --init` delivers a stop's SIGTERM to it.
CMD ["sh","-c","cd /app/servers/node && exec node --import tsx src/server.ts"]
