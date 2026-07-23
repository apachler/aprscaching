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
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app /app
EXPOSE 8080
# Default = gateway; compose overrides `command:` for the ingest. The built SPA sits at
# /app/apps/web/dist — the compose `webdist` one-shot copies it into the volume Caddy serves.
CMD ["pnpm","--filter","@aprscaching/node-gateway","start"]
