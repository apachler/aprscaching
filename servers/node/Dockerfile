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
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app

ENV PORT=8787 DB_PATH=/data/aprscaching.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["pnpm", "--filter", "@aprscaching/node-gateway", "start"]
