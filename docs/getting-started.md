# Getting started

This page runs a full aprscaching stack on your own machine: the gateway (API + data), the web app, and
optionally the RF ingest box. It assumes **Node 20+** and **pnpm**.

## Install

```bash
pnpm install
pnpm -r test      # run every package's unit suite
pnpm -r build     # typecheck + build all units
```

## Run the gateway

The gateway is the API and data plane. Pick one runtime — all three serve the same API and pass the same
conformance suite.

=== "Node + SQLite (simplest)"

    ```bash
    pnpm --filter @aprscaching/node-gateway start
    # serves /health, /ingest, /api/*, /ws on http://127.0.0.1:8787
    ```

    The schema is applied automatically from `db/migrations/` into a local SQLite file
    (`DB_PATH`, default under `servers/node/data/`).

=== "Cloudflare Worker + D1"

    ```bash
    cd workers/gateway
    npx wrangler d1 create aprscaching                    # paste the database_id into wrangler.toml
    npx wrangler d1 migrations apply aprscaching --local  # schema from ../../db/migrations
    npx wrangler dev                                      # http://127.0.0.1:8787
    ```

=== "Bun (single-file desktop)"

    ```bash
    bun run servers/bun/server.ts
    ```

## Run the web app

```bash
pnpm --filter @aprscaching/web dev
```

The app talks to the gateway at `VITE_API_BASE` (default `http://127.0.0.1:8787`). Open the printed URL and
you can browse the map, hide a cache, and log a find. In-app geolocation (**Tier B**) needs HTTPS or
`localhost` and the browser's location permission.

## Add RF ingest (optional)

The **ingest box** feeds real radio into your instance. It runs on your own hardware — a Pi, a PC, or the
browser bridging a USB/BLE radio. Copy the example config and point it at your gateway:

```bash
cp .env.example .env         # set APRSIS_FILTER + INGEST_SECRET; add KISS_TNC_HOST, MESH_HOST, … as needed
pnpm --filter @aprscaching/ingest dev
```

With just `APRSIS_FILTER` it streams a slice of the global APRS-IS firehose. Add a KISS TNC, a Meshtastic
node, an AXUDP/AXIP link, or a TAK/CoT feed and each forwards to the gateway on its own port. See
[RF ingest & transports](operate/rf-ingest.md) for every transport and its configuration.

!!! note "Off-grid works"
    Point `INGEST_URL` at a gateway on the same box (`http://localhost:8787/ingest`) and the whole
    stack — RF in, map out — runs with no internet at all.

## Verify your checkout

```bash
pnpm -r test                 # all unit suites
node apps/web/test/no-emoji.mjs   # web asset guard
tools/dev/smoke.sh           # spin a throwaway gateway and run the conformance smoke suites
```

## Where to next

- Understand the trust model before deploying: [Core concepts](concepts.md).
- Ship it: [Deployment](operate/deployment.md).
- Every setting: [Configuration reference](reference/configuration.md).
