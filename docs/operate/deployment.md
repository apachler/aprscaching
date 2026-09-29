# Deployment

aprscaching separates two concerns that deploy independently:

- the **gateway** (API + data plane), which runs on any of three interchangeable runtimes, and
- the **RF ingest**, which is always operator-local.

You pick one of three topologies below. Once it is up, work through
[Your first hour as sysop](first-hour.md) — the ordered checklist from "it boots" to a public,
verified, backed-up instance (mirrored live in the app under **Instance admin → Setup**).

## The three gateway runtimes

One codebase, one conformance suite, three runtimes:

| Runtime | Package | Storage | Best for |
|---------|---------|---------|----------|
| **Cloudflare Worker + D1** | `workers/gateway` | D1 (+ R2 for media) | Edge / serverless, global |
| **Node + SQLite** | `servers/node` | `better-sqlite3` | Self-host on a Pi or VM |
| **Bun + bun:sqlite** | `servers/bun` | `bun:sqlite` | A single-file desktop build |

All three runtimes support the full feature set and the complete configuration — the Node and Bun servers
forward every gateway config key from the process environment, so rate limits, spots, email/push, and the
sysop surface work identically self-hosted. The runtime differences are infrastructural only (cron triggers
vs in-process intervals, D1/R2 vs SQLite/filesystem). See the
[Configuration reference](../reference/configuration.md).

## Three ways to deploy

| Topology | Gateway | Ingress | Operator-local ingest | Walkthrough |
|----------|---------|---------|-----------------------|-------------|
| [**Desktop**](#desktop) | Bun single binary | none — `127.0.0.1`, or the LAN with `HOST=0.0.0.0` | the browser RF bridge, or `apps/ingest` beside it | `deploy/desktop/README.md` |
| [**Self-host**](#self-host) | Node + SQLite in the Docker stack | Caddy with automatic TLS, or a Cloudflare Tunnel; optionally Cloudflare's CDN in front | the stack's own `ingest` service, or `compose.ingest-only.yml` on the radio box | [Running in Docker](docker.md) |
| [**Cloudflare**](#cloudflare) | Worker + D1 + R2, SPA on Pages | Cloudflare's edge | `compose.ingest-only.yml` on your own box | `deploy/README.md` |

In every topology the RF ingest runs on your own equipment (`compose.ingest-only.yml` points it at any
gateway), and the browser can bridge a USB or Bluetooth radio with no server at all.

### Desktop

One executable (`bun build --compile`) with the gateway, the web app and the migrations inside. It keeps
SQLite in the OS data directory and generates `INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET` there on
first run. Best for one operator, a field day, or trying it out; it works off-grid.

### Self-host

The Docker stack (`deploy/docker-compose.yml`: gateway, ingest, Caddy) on anything that runs Docker — a
Pi at home, a mini-PC, an OCI or other cloud VM. `deploy/setup.sh` writes its whole configuration and asks
how people reach it:

- **Caddy with TLS** — a public hostname, ports 80 and 443 open; Caddy fetches the certificate.
- **Cloudflare Tunnel** — no open ports, no static IP (home connections, CGNAT); `compose.home.yml` adds the
  connector.
- **LAN / off-grid** — plain http on the local network, no internet needed; members sign in with the
  operator's [one-time link](first-hour.md#off-grid-sign-in).

A public box may put Cloudflare's CDN in front (`deploy/cloudflare/cache-rules.sh`, `TRUST_CF=1`). Oracle
Cloud users can start the same stack with the
[one-click OCI stack](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip).
Bare metal without Docker: the systemd units in `deploy/systemd/` run the same gateway and ingest from a
checkout.

### Cloudflare

A managed core: the Worker gateway with D1 and R2, and the SPA on Pages, set up by
`deploy/cloudflare/deploy-cf.sh`. Nothing of yours runs in the cloud except that; the RF ingest runs on your
own box with `compose.ingest-only.yml` and `INGEST_URL` pointing at the Worker. A cloud VM may add an
APRS-IS-only feed the same way, never the RF bridge.

## Secrets every deployment sets

!!! warning "Three distinct secrets"
    | Secret | Gateway | Ingest box | If unset |
    |---|---|---|---|
    | `INGEST_SECRET` | required | required (the same value) | Node/Bun refuse to boot |
    | `OPERATOR_SECRET` | optional | **never** | operator scripts (`tools/admin/*`) are refused; the web sysop surface still works |
    | `SESSION_SECRET` | required for sign-in | **never** | Node/Bun/desktop generate one beside the database; the Worker mints no session |

    The three must differ from each other; the Node/Bun servers refuse to boot on an `OPERATOR_SECRET` or
    `SESSION_SECRET` equal to `INGEST_SECRET`. Generate each with `openssl rand -hex 32`.

    - **Self-host (Docker):** `deploy/setup.sh` generates `INGEST_SECRET` and `OPERATOR_SECRET` in
      `deploy/.env` and leaves `SESSION_SECRET` for the gateway to generate; the compose file blanks the
      operator and session secrets (and the federation key) for the ingest container.
    - **Cloudflare:** `npx wrangler secret put INGEST_SECRET`, `… OPERATOR_SECRET` and `… SESSION_SECRET`
      (`deploy/cloudflare/deploy-cf.sh` asks for all three).
    - **systemd / bare metal:** add them to `deploy/.env`; leave `SESSION_SECRET` empty to have the gateway
      generate `data/session.secret`.
    - **Desktop:** generated on first run into the data directory.

### Upgrading an existing deployment

- **Set `OPERATOR_SECRET`** on the gateway if you run `tools/admin/verify-call.mjs`, change peer trust or
  forwarding partners/rules from scripts, or confirm donations. Those calls authenticate with
  `x-operator-secret`; the ingest secret does not reach them.
- **Set `SESSION_SECRET`** on the Worker (`npx wrangler secret put SESSION_SECRET`). The Node/Bun servers
  generate one on first start when it is unset. A session binds to its account, and a cookie without that
  binding is not accepted, so every user signs in once after the upgrade.
- **Pair remote boxes.** A box answers only the account it is paired to: restart the ingest box, read the
  pairing code it prints, and enter it under **Shack → Remote box**.
- **Dev setups with the SPA on another origin** (`pnpm dev:web`) set `CORS_ORIGINS=http://localhost:5173`
  on the gateway; without an allowlist no cross-origin request carries a session.
- A device key binds only through its holder's signed-in session. If an ingest secret may have leaked,
  rotate it and review `callsign_keys` for keys their holders did not register.

## Where RF comes in

The **ingest box** is never part of the cloud gateway — it always runs on the operator's own equipment, and
`INGEST_URL` can point at a gateway on `localhost`, a LAN box, or a remote cloud. This is what makes off-grid
operation work: run the ingest and a Node gateway on one machine with `INGEST_URL=http://localhost:8787/ingest`
and the whole stack runs with no internet. A cloud VM *may* additionally run an APRS-IS-only ingest for a
baseline global feed, but that is never the only way to get RF in. See
[RF ingest & transports](rf-ingest.md).

## Two required obligations for a public instance

1. **Expose your source (AGPL §13).** Set `SOURCE_REPO` to your published fork and keep `SOURCE_COMMIT`
   accurate. Every instance serves a machine-readable descriptor at `GET /.well-known/source` and shows a
   "Source" link in the UI. This is required, not optional.
2. **Back up your database.** Positions are TTL'd, but caches, finds, accounts, and keys are the record of
   your instance — back up the D1/SQLite database.

## Sign your feeds

To take part in federation, generate an instance key and set it as a secret so your feeds are signed:

`deploy/setup.sh` generates the key for the Docker stack. Elsewhere:

```bash
node tools/fedkey/genkey.mjs        # prints FED_PRIVATE_KEY + the public key it publishes
# Cloudflare:  npx wrangler secret put FED_PRIVATE_KEY
# Node/Bun:    export FED_PRIVATE_KEY=...
```

The instance id (`INSTANCE`) follows `APP_URL`'s host.

Without a key, feeds still serve — unsigned — and peers won't mirror them. See [Federation](../guides/federation.md).
