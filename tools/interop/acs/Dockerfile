# Our full stack for the interop environment: the Node gateway + the ingest (AXUDP port, NET/ROM
# node, SID-gated BBS, FBB forwarding scheduler) in one container. Built from the repo root context.
FROM node:24-bookworm-slim
# better-sqlite3 compiles from source (v13 ships no prebuilt binaries) — node-gyp needs
# python3 + a C/C++ toolchain, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc* ./
COPY packages ./packages
COPY servers/node ./servers/node
COPY workers/gateway ./workers/gateway
COPY apps/ingest ./apps/ingest
COPY db ./db
RUN pnpm install --frozen-lockfile --filter @aprscaching/node-gateway... --filter @aprscaching/ingest...
COPY tools/interop/acs/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8787 10093/udp
CMD ["/start.sh"]
