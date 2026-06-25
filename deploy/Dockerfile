# syntax=docker/dockerfile:1
# Multi-arch (amd64 + arm64) image for the Node gateway + ingest.
# Build context = repo root:  docker build -f deploy/Dockerfile -t aprscaching:local ..
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY . .
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm -r build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app /app
EXPOSE 8080
# Default = gateway; compose overrides `command:` for the ingest.
# NOTE: adjust the pnpm --filter names to match your package.json if different.
CMD ["pnpm","--filter","@aprsweb/node-gateway","start"]
