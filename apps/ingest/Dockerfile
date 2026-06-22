FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @aprsweb/ingest... install
CMD ["pnpm","--filter","@aprsweb/ingest","start"]
