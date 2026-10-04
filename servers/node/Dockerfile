# Portable aprscaching gateway — Node + SQLite, no Cloudflare.
# Build from the REPO ROOT:
#   docker build -f servers/node/Dockerfile -t aprscaching-node .
#   docker run -p 8787:8787 -v aprscaching-data:/data -e INGEST_SECRET=... aprscaching-node
# better-sqlite3 compiles from source (v13 ships no prebuilt binaries), so the build stage
# carries the node-gyp toolchain; the runtime stage stays slim.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Install just the node-gateway and its workspace deps
COPY . .
RUN pnpm install --frozen-lockfile --filter @aprscaching/node-gateway...

FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY --from=build /app /app
# Runs as the unprivileged user aprscaching (UID and GID 10001), as deploy/Dockerfile does; /data belongs to it.
RUN corepack enable && corepack install \
 && groupadd --system --gid 10001 aprscaching \
 && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/aprscaching \
      --shell /usr/sbin/nologin aprscaching \
 && mkdir -p /data && chown 10001:10001 /data
USER 10001

ENV PORT=8787 DB_PATH=/data/aprscaching.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["pnpm", "--filter", "@aprscaching/node-gateway", "start"]
