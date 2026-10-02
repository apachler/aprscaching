# Run from source

This page shows contributors how to run aprscaching from a checkout: the gateway, the web app and, if you
need it, the RF ingest. You need Node 22 or newer and pnpm; at the end the app runs on your machine against a
local gateway. To install an instance for real use, see [Is running an instance for me?](../run/index.md).

## Before you start

- **Node 22 or newer** (CI uses 24).
- **pnpm**: `corepack enable` provides the version the repository pins.

## Install

```bash
pnpm install
pnpm run check    # build every unit, run every unit suite, typecheck and build the web app
```

## Run the gateway

The gateway is the API and data plane. Pick one runtime: all three serve the same API and pass the same
conformance suites ([Architecture and runtimes](architecture.md)).

Every runtime needs an **ingest secret**: the gateway refuses to start without one, and the ingest sends the
same value. Make one and keep it for the steps below:

```bash
openssl rand -hex 24
```

=== "Node + SQLite"

    ```bash
    INGEST_SECRET=<your secret> pnpm --filter @aprscaching/node-gateway start
    # serves /health, /ingest, /api/*, /ws on http://127.0.0.1:8787
    ```

    The server applies the schema from `db/migrations/` into a local SQLite file (`DB_PATH`, by default under
    `servers/node/data/`).

=== "Cloudflare Worker + D1"

    Put `INGEST_SECRET=<your secret>` in `workers/gateway/.dev.vars` (git-ignored) first; `wrangler dev` reads
    its secrets from there.

    ```bash
    cd workers/gateway
    npx wrangler d1 create aprscaching                    # paste the database_id into wrangler.toml
    npx wrangler d1 migrations apply aprscaching --local  # schema from ../../db/migrations
    npx wrangler dev                                      # http://127.0.0.1:8787
    ```

    `pnpm --filter @aprscaching/gateway migrate && pnpm dev:gateway` does the same on a local D1.

=== "Bun"

    ```bash
    INGEST_SECRET=<your secret> bun run servers/bun/server.ts
    ```

**Check it worked:** `curl -fsS http://127.0.0.1:8787/health` answers.

## Run the web app

```bash
pnpm dev:web
```

The app talks to the gateway at `VITE_API_BASE`; the dev server defaults to `http://127.0.0.1:8787`, and a
production build without it uses its own origin. The dev server runs on another origin than the gateway, so
start the gateway with `CORS_ORIGINS=http://localhost:5173`: without that allowlist no cross-origin request
carries a session, and sign-in fails.

Open the printed URL to browse the map, hide a cache and log a find. In-app geolocation (Tier B) needs
`https` or `localhost` and the browser's location permission.

`/?demo=app` serves the whole app from canned gateway answers, and `/?demo=ui` shows every token and
component ([Design and accessibility](testing.md#design-and-accessibility)).

## Run the ingest

The ingest feeds real radio and APRS-IS into your gateway. Copy the example settings and start it:

```bash
cp .env.example .env
pnpm dev:ingest
```

Edit `.env` at the top of the checkout first: set `APRSIS_FILTER`, set `INGEST_SECRET` to the **same value the
gateway runs with**, and add `KISS_TNC_HOST`, `MESHTASTIC_HOST` and others as needed. With only
`APRSIS_FILTER` it streams a slice of the global APRS-IS feed.

**Check it worked:** the gateway's `/api/ports` lists the ingest's ports, and stations appear on the map.

Each radio link and every ingest setting are covered for operators under
[Connect a radio: quick starts](../run/radios/quick-starts.md) and
[RF ingest & transports](../run/radios/rf-ingest.md).

## Check your checkout

```bash
pnpm run check               # build + every unit suite (includes the web guards)
pnpm run smoke               # a throwaway gateway and the conformance smoke suites
pnpm run verify              # both: the full gate before committing
```

## Next

- [Testing & verification](testing.md): every check and how to run one test.
- [Architecture and runtimes](architecture.md): where a change belongs.
