# Deployment

aprscaching separates two concerns that deploy independently:

- the **gateway** (API + data plane), which runs on any of three interchangeable runtimes, and
- the **RF ingest**, which is always operator-local.

You mix and match them into a topology that fits your hosting. Once your shape is up, work through
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

## Topologies

| # | Shape | How | Walkthrough |
|---|-------|-----|-------------|
| **0** | Desktop single binary | `bun --compile` bundles the SPA + migrations into one executable. | `deploy/desktop/README.md` |
| **1** | Pi at home | Docker stack on a Pi, exposed with a free Cloudflare Tunnel — no port-forward, no static IP. | [Running in Docker](docker.md) + `deploy/README.md` |
| **2** | All-in-one VM | Docker stack (gateway + ingest + Caddy TLS) on a single OCI/VPS host; `deploy/setup.sh` is the first-run wizard. | [Running in Docker](docker.md) · [one-click stack](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip) |
| **3** | OCI core + CDN | Topology 2 plus Cloudflare's CDN in front (`deploy/cloudflare/cache-rules.sh`). | [Running in Docker](docker.md) |
| **4** | Split | Managed Cloudflare core (Worker + D1 + R2 + Pages) via `deploy/cloudflare/deploy-cf.sh`; the operator RF box runs the ingest-only stack. | [Running in Docker](docker.md) + `deploy/README.md` |

`deploy/` carries the scaffolding for every shape: the multi-arch image + compose files, systemd units,
the OCI Terraform/Resource-Manager one-click, the Cloudflare one-shot, `setup.sh` (first-run wizard,
generates `INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET`), and `backup.sh`. Bare-metal without
Docker: the systemd units in `deploy/systemd/` run the same gateway + ingest from a checkout.

## Secrets every deployment sets

!!! warning "Three distinct secrets"
    | Secret | Gateway | Ingest box | If unset |
    |---|---|---|---|
    | `INGEST_SECRET` | required | required (the same value) | Node/Bun refuse to boot |
    | `OPERATOR_SECRET` | optional | **never** | operator scripts (`tools/admin/*`) are refused; the web sysop surface still works |
    | `SESSION_SECRET` | required for sign-in | **never** | Node/Bun/desktop generate one beside the database; the Worker mints no session |

    The three must differ from each other; the Node/Bun servers refuse to boot on an `OPERATOR_SECRET` or
    `SESSION_SECRET` equal to `INGEST_SECRET`. Generate each with `openssl rand -hex 32`.

    - **Docker (topologies 1–3):** `deploy/setup.sh` fills all three in `deploy/.env`; the compose file
      blanks the operator and session secrets for the ingest container.
    - **Cloudflare Worker (topology 4):** `npx wrangler secret put INGEST_SECRET`, `… OPERATOR_SECRET` and
      `… SESSION_SECRET` (`deploy/cloudflare/deploy-cf.sh` asks for all three).
    - **systemd / bare metal:** add them to `deploy/.env`; leave `SESSION_SECRET` empty to have the gateway
      generate `data/session.secret`.
    - **Desktop (topology 0):** generated on first run into the data directory.

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

```bash
node tools/fedkey/genkey.mjs        # prints FED_PRIVATE_KEY + the public key it publishes
# Cloudflare:  npx wrangler secret put FED_PRIVATE_KEY   (and set INSTANCE)
# Node/Bun:    export FED_PRIVATE_KEY=...  INSTANCE=oe.example.org
```

Without a key, feeds still serve — unsigned — and peers won't mirror them. See [Federation](../guides/federation.md).
