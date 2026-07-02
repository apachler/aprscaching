# Deployment

aprscaching separates two concerns that deploy independently:

- the **gateway** (API + data plane), which runs on any of three interchangeable runtimes, and
- the **RF ingest**, which is always operator-local.

You mix and match them into a topology that fits your hosting.

## The three gateway runtimes

One codebase, one conformance suite, three runtimes:

| Runtime | Package | Storage | Best for |
|---------|---------|---------|----------|
| **Cloudflare Worker + D1** | `workers/gateway` | D1 (+ R2 for media) | Edge / serverless, global |
| **Node + SQLite** | `servers/node` | `better-sqlite3` | Self-host on a Pi or VM |
| **Bun + bun:sqlite** | `servers/bun` | `bun:sqlite` | A single-file desktop build |

The Worker runtime supports the full feature set. The Node and Bun servers map a subset of configuration —
notably the public read-API rate limits, live activity spots, email/push, and (Bun only) the web sysop
surface are Worker-only. See the [Configuration reference](../reference/configuration.md) for the exact
coverage.

## Topologies

| # | Shape | How |
|---|-------|-----|
| **0** | Desktop single binary | `bun --compile` bundles the SPA + migrations into one executable (`deploy/desktop/`). |
| **1** | Pi at home | Node gateway on a Pi, exposed with a free Cloudflare Tunnel — no port-forward, no static IP. |
| **2** | All-in-one VM | Node gateway + Caddy on a single OCI/VPS host. |
| **3** | OCI core + CDN | Node gateway behind Cloudflare's CDN. |
| **4** | Split | RF ingest on an OCI box feeding Cloudflare Workers + D1 + R2. |

Detailed recipes and the `deploy/` scaffolding are validated at deploy time. Topology 0 (the desktop binary)
ships built and validated.

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
