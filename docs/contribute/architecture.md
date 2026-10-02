# Architecture and runtimes

APRScaching is one gateway that runs on three runtimes, a web app, and an ingest that always runs on the
operator's own equipment.

## The pieces

| Piece | What it is |
|-------|------------|
| **Gateway** | The API + data plane. Runs as a Cloudflare Worker + D1, plain Node + SQLite, or Bun — one conformance suite proves all three identical. |
| **Web app** | A React + MapLibre single-page app: the map, the Shack, and the operator surface. |
| **Ingest** | The operator-local RF bridge (a Pi/PC process, or the browser over Web Serial/Bluetooth). Always runnable on your own equipment; never cloud-only. |
| **Libraries** | Pure, reusable codecs (`@aprscaching/aprs`, `@aprscaching/ax25`, `@aprscaching/packet`, `@aprscaching/tools`) and typed contracts (`@aprscaching/shared`). |

Start with [Run from source](run-from-source.md) to run it locally, or [The trust model](../reference/trust-model.md) to
understand the trust model before you deploy.

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

## Runtimes and locality

- The **gateway** runs identically on three runtimes — Cloudflare Worker + D1, Node + SQLite, or Bun — proven
  by one conformance suite. Choose by where you want to host ([Is running an instance for me?](../run/index.md)).
- The **RF ingest is always operator-local**: a process on your own Pi/PC, or the browser bridging a USB/BLE
  radio. It is never cloud-only, and off-grid operation (ingest + gateway on one box, no internet) is a
  first-class mode.
- Every public instance must expose its own source (a visible link and `/.well-known/source`) to satisfy the
  AGPL's network-use clause.

## Federation in brief

Any instance — edge or self-hosted — publishes **read-only, Ed25519-signed feeds** (caches, finds, keys,
bulletins, tombstones). Peers mirror each other into a shared catalog after verifying every record's
signature against the publisher's key. Peers carry **trust tiers** (`trusted` / `unvetted` / `blocked`) and a
reputation; a signed **instance registry** (with a DNS-TXT anchor) binds instance names to keys. Firewalled
peers can still contribute through **push-to-hub** and a poll-based **rendezvous relay**. GDPR deletions
propagate as signed **tombstones**. See [Join the network](../run/federation/index.md).

## Standalone images

Two single-service Dockerfiles exist for mix-and-match setups: `servers/node/Dockerfile` (gateway
only) and `apps/ingest/Dockerfile` (ingest only). Both build from the repo root.

## Next

- [Testing & verification](testing.md).
