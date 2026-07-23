# Portable aprscaching gateway — Node + SQLite, no Cloudflare.
# Build from the REPO ROOT:
#   docker build -f servers/node/Dockerfile -t aprscaching-node .
#   docker run -p 8787:8787 -v aprscaching-data:/data -e INGEST_SECRET=... aprscaching-node
FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# Install just the node-gateway and its workspace deps (better-sqlite3 fetches a prebuilt binary).
COPY . .
RUN pnpm install --frozen-lockfile --filter @aprscaching/node-gateway...

ENV PORT=8787 DB_PATH=/data/aprscaching.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["pnpm", "--filter", "@aprscaching/node-gateway", "start"]
