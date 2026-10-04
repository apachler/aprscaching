# Standalone ingest image — build from the REPO ROOT:
#   docker build -f apps/ingest/Dockerfile -t aprscaching-ingest .
# Node 24 matches CI; corepack activates the pnpm pinned in package.json.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @aprscaching/ingest...
# Runs as the unprivileged user aprscaching (UID and GID 10001), as deploy/Dockerfile does; `dialout` opens a
# serial TNC or PTT passed in with --device.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack install \
 && groupadd --system --gid 10001 aprscaching \
 && useradd --system --uid 10001 --gid 10001 --groups dialout --create-home --home-dir /home/aprscaching \
      --shell /usr/sbin/nologin aprscaching
USER 10001
CMD ["pnpm","--filter","@aprscaching/ingest","start"]
