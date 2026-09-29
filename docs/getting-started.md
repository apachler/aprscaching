# Run from source

This page is for developers and for operators who want to run aprscaching from a checkout of the code: the
gateway (API + data), the web app, and optionally the RF ingest box. To just use aprscaching, see
[Start here](start-here.md); to install an instance, [Running in Docker](operate/docker.md) is the usual
route.

You need **Node 22 or newer** and **pnpm** (`corepack enable` provides the pinned version).

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

The app talks to the gateway at `VITE_API_BASE` (the dev server defaults to `http://127.0.0.1:8787`; a
production build without it uses its own origin). Open the printed URL and
you can browse the map, hide a cache, and log a find. In-app geolocation (**Tier B**) needs HTTPS or
`localhost` and the browser's location permission.

## Add RF ingest (optional)

The **ingest box** feeds real radio into your instance. It runs on your own hardware — a Pi, a PC, or the
browser bridging a USB/BLE radio. Copy the example config and point it at your gateway:

```bash
cp .env.example .env
pnpm --filter @aprscaching/ingest dev
```

Edit `.env` at the top of the checkout first: set `APRSIS_FILTER` and `INGEST_SECRET`, and add
`KISS_TNC_HOST`, `MESHTASTIC_HOST`, … as needed.

With just `APRSIS_FILTER` it streams a slice of the global APRS-IS firehose. Add a KISS TNC, a Meshtastic
node, or an AXUDP/AXIP link and each forwards to the gateway on its own port. See
[Connect a radio: quick starts](operate/quickstarts.md) for each link step by step, and
[RF ingest & transports](operate/rf-ingest.md) for every setting.

!!! note "Off-grid works"
    Point `INGEST_URL` at a gateway on the same box (`http://localhost:8787/ingest`) and the whole
    stack — RF in, map out — runs with no internet at all.

## Verify your checkout

```bash
pnpm run check               # build + every unit suite (includes the web guards)
pnpm run smoke               # spin a throwaway gateway and run the conformance smoke suites
pnpm run verify              # both — the full gate before committing
```

## Where to next

- Understand the trust model before deploying: [Core concepts](concepts.md).
- Ship it: [Deployment](operate/deployment.md).
- Every setting: [Configuration reference](reference/configuration.md).
