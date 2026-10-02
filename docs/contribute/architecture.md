# Architecture and runtimes

This page explains how the aprscaching code base fits together: one gateway that runs on three runtimes, a
web app, an ingest that runs on the operator's own equipment, and the libraries underneath. It is for
contributors deciding where a change belongs.

## The pieces

```mermaid
flowchart TB
  web["apps/web<br/>React + MapLibre SPA"]
  ingest["apps/ingest<br/>operator-local RF and APRS-IS"]
  app["workers/gateway/src/app.ts<br/>handle() · runScheduled · runFrequentSync"]
  worker["Cloudflare Worker<br/>D1 · R2 · Durable Objects"]
  node["servers/node<br/>Node + better-sqlite3"]
  bun["servers/bun<br/>Bun + bun:sqlite · desktop"]
  db[("db/migrations<br/>one schema")]
  pkgs["packages/* (MIT)<br/>aprs · ax25 · packet · tools · shared"]
  web --> app
  ingest --> app
  app --> worker
  app --> node
  app --> bun
  db --> worker
  db --> node
  db --> bun
  pkgs --> web
  pkgs --> ingest
  pkgs --> app
```

| Piece | What it is |
|-------|------------|
| **Gateway** (`workers/gateway`) | The API and data plane. `app.ts` exports a runtime-neutral `handle()`, plus `runScheduled` and `runFrequentSync`. Routing is the `p === "/…"` table and the regex segment routes in that file; each feature is one module beside it (`verify.ts`, `webauthn.ts`, `ingest.ts`, …). |
| **Runtime shims** (`servers/node`, `servers/bun`) | They import the same app and supply the Cloudflare bindings themselves: a D1-compatible shim over better-sqlite3 or `bun:sqlite` (`d1.ts`), a socket adapter over the shared `rooms-core.ts` for the `RegionRoom` Durable Object, filesystem media for R2, and the shared migration runner. Bun reuses the Node host modules; the desktop launcher (`deploy/desktop/`) wraps `servers/bun/server.ts`'s `createServer()`. |
| **Web app** (`apps/web`) | A React and MapLibre single-page app: the map, the Shack and the operator surface. |
| **Ingest** (`apps/ingest`) | The operator-local RF and APRS-IS bridge, a process on a Pi or PC. The browser bridges a USB or Bluetooth radio the same way. |
| **Libraries** (`packages/*`) | Pure, reusable codecs (`@aprscaching/aprs`, `@aprscaching/ax25`, `@aprscaching/packet`, `@aprscaching/tools`) and typed contracts (`@aprscaching/shared`). They run in the Worker, Node, Bun and the browser, and stay MIT-licensed with no AGPL-only dependency. |

Fix behaviour in `workers/gateway`, never in one runtime's shim.

## The three gateway runtimes

| Runtime | Package | Storage | Shape |
|---------|---------|---------|-------|
| **Cloudflare Worker + D1** | `workers/gateway` | D1, with R2 for media | Cloudflare split |
| **Node + SQLite** | `servers/node` | `better-sqlite3`, filesystem media | Self-host, Pocket |
| **Bun + bun:sqlite** | `servers/bun` | `bun:sqlite`, filesystem media | Desktop |

All three support the full feature set and the complete configuration: the Node and Bun servers forward every
gateway configuration key from the process environment. The differences are infrastructural only: cron
triggers against in-process intervals, D1 and R2 against SQLite and the filesystem. CI proves parity by
running the same `tools/smoke/*` suites against all three ([Testing & verification](testing.md)).

## The ingest stays local

The RF ingest always runs on the operator's own equipment: `apps/ingest` on a Pi, PC or mini-PC, or the
browser bridging a radio over Web Serial or Web Bluetooth. It is never cloud-only, and its `INGEST_URL` can
point at `localhost`, a LAN gateway or a remote one. Off-grid operation, with the ingest and the gateway on
one box and no internet, is a first-class mode. A cloud machine may run an APRS-IS-only feed, never the only
way RF gets in.

## One schema

The schema lives once, in `db/migrations/*.sql`, starting with `0001_baseline.sql`. Wrangler applies it to D1
(`migrations_dir = "../../db/migrations"`), and the Node and Bun servers apply it at boot. A schema change is a
new file with the next number; a file that has been applied is never edited.

## Images

`deploy/Dockerfile` builds the full image from the repository root: it installs the workspace with the pinned
pnpm, builds every package (the web app into `apps/web/dist` inside the image) and starts the gateway by
default. The same image runs the ingest through a compose `command:` override.

```bash
docker build -f deploy/Dockerfile -t aprscaching:local .
```

Two single-service Dockerfiles exist for mix-and-match setups: `servers/node/Dockerfile` (the gateway only) and
`apps/ingest/Dockerfile` (the ingest only). Both build from the repository root.

## Every public instance shows its source

Every public instance exposes a visible **Source** link and `/.well-known/source`, as the AGPL's network-use
clause requires.

## Next

- [Testing & verification](testing.md): every check and how to run it.
- [The trust model](../reference/trust-model.md): the rules the gateway enforces.
