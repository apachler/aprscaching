# Standalone ingest image — build from the REPO ROOT:
#   docker build -f apps/ingest/Dockerfile -t aprscaching-ingest .
# Node 24 matches CI; corepack activates the pnpm pinned in package.json.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @aprscaching/ingest...
CMD ["pnpm","--filter","@aprscaching/ingest","start"]
