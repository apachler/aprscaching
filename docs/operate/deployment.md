# Deployment

aprscaching separates two concerns that deploy independently:

- the **gateway** (API + data plane), which runs on any of three interchangeable runtimes, and
- the **RF ingest**, which is always operator-local.

You pick one of three shapes — **Self-host**, **Desktop** or **Cloudflare split** — or run Self-host on a
phone as **Pocket**. Once it is up, work
through [Your first hour as sysop](first-hour.md) — the ordered checklist from "it boots" to a public,
verified, backed-up instance (mirrored live in the app under **Instance admin → Setup**).

## Which shape should I pick?

- **Self-host** — the recommended default. The Docker stack on a Pi, a mini-PC or a VM runs the gateway, the
  RF ingest and TLS on one box you own. Its cost is flat: SQLite on your own disk costs the same at ten
  packets a minute as at a thousand, so a large or global APRS-IS filter is no problem. It also matches the
  project's rule that the RF ingest runs on the operator's own equipment — here the ingest sits right next to
  the gateway.
- **Desktop** — one executable, no Docker. Pick it to try the platform out, for a field day, or for a
  single operator off-grid.
- **On a phone** — [Pocket](pocket.md) runs the Self-host gateway and ingest on an Android phone in Termux:
  a field-day and demo station with its own hotspot and a MeshCom node, not an always-on server.
- **Cloudflare split** — no server of your own to maintain for the gateway: Cloudflare runs it, and your
  own box runs only the RF ingest. D1 bills every row written, so the cost grows with your feed. It suits
  small regional feeds and operators who want no maintenance; big or global feeds belong on Self-host.

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

| Shape | Gateway | Ingress | Operator-local ingest | Walkthrough |
|-------|---------|---------|-----------------------|-------------|
| [**Self-host**](#self-host) (recommended) | Node + SQLite in the Docker stack | Caddy with automatic TLS, or a Cloudflare Tunnel; optionally Cloudflare's CDN in front | the stack's own `ingest` service, or `compose.ingest-only.yml` on the radio box | [Running in Docker](docker.md) |
| [**Desktop**](#desktop) | Bun single binary | none — `127.0.0.1`, or the LAN with `HOST=0.0.0.0` | the browser RF bridge, or `apps/ingest` beside it | `deploy/desktop/README.md` |
| [**Cloudflare split**](#cloudflare-split) | Worker + D1 + R2, SPA on Pages | Cloudflare's edge | `compose.ingest-only.yml` on your own box | `deploy/README.md` |

In every shape the RF ingest runs on your own equipment (`compose.ingest-only.yml` points it at any
gateway), and the browser can bridge a USB or Bluetooth radio with no server at all.

### Self-host

The recommended shape. The Docker stack (`deploy/docker-compose.yml`: gateway, ingest, Caddy) runs on anything
that runs Docker — a Pi at home, a mini-PC, an OCI or other cloud VM. `deploy/setup.sh` writes its whole
configuration and asks how people reach it:

- **Caddy with TLS** — a public hostname, ports 80 and 443 open; Caddy fetches the certificate.
- **Cloudflare Tunnel** — no open ports, no static IP (home connections, CGNAT); `compose.home.yml` adds the
  connector.
- **LAN / off-grid** — plain http on the local network, no internet needed; members sign in with the
  operator's [one-time link](first-hour.md#off-grid-sign-in).

A licensed operator can also give the box a static 44.x address over a 44Net Connect WireGuard tunnel —
reachable without port forwarding, even behind CGNAT — and publish its federation identity under
`<call>.ampr.org`: see [Run an instance on 44Net](44net.md).

A public box may put Cloudflare's CDN in front (`deploy/cloudflare/cache-rules.sh`, `TRUST_CF=1`). Oracle
Cloud users can start the same stack with the
[one-click OCI stack](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip).
Bare metal without Docker: the systemd units in `deploy/systemd/` run the same gateway and ingest from a
checkout.

### Desktop

One executable (`bun build --compile`) with the gateway, the web app and the migrations inside. It keeps
SQLite in the OS data directory and generates `INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET` there on
first run. Best for one operator, a field day, or trying it out; it works off-grid.

### Cloudflare split

A managed core: the Worker gateway with D1 and R2, and the SPA on Pages, set up by
`deploy/cloudflare/deploy-cf.sh`. Nothing of yours runs in the cloud except that; the RF ingest runs on your
own box with `compose.ingest-only.yml` and `INGEST_URL` pointing at the Worker. A cloud VM may add an
APRS-IS-only feed the same way, never the RF bridge. Back it up with D1 Time Travel and a copy of the R2
media — see [Backups](#backups).

Set the Worker's `APP_URL` to the Pages site. The embeddable map widget (`/embed`) is served by the Worker
but loads MapLibre from the web app's build at `APP_URL`; the build's `_headers` file lets Pages serve that
copy to the Worker's origin.

Cost scales with rows written: [Cloudflare D1 costs](../reference/cloudflare-costs.md) has the sizing
table and the write budget that caps it.

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
    - **Cloudflare split:** `npx wrangler secret put INGEST_SECRET`, `… OPERATOR_SECRET` and `… SESSION_SECRET`
      (`deploy/cloudflare/deploy-cf.sh` asks for all three).
    - **systemd / bare metal:** add them to `deploy/.env`; leave `SESSION_SECRET` empty to have the gateway
      generate `data/session.secret`.
    - **Desktop:** generated on first run into the data directory.

### Operator scripts, sessions and remote boxes

- **`OPERATOR_SECRET`** is needed on the gateway if you run `tools/admin/verify-call.mjs`, change peer trust
  or forwarding partners/rules from scripts, or confirm donations. Those calls authenticate with
  `x-operator-secret`; the ingest secret does not reach them.
- **`SESSION_SECRET`** must be set on the Worker (`npx wrangler secret put SESSION_SECRET`); the Node/Bun
  servers generate one on first start when it is unset. A session binds to its account, and a cookie without
  that binding is not accepted, so changing `SESSION_SECRET` signs every user out once.
- **Remote boxes are paired.** A box answers only the account it is paired to: the ingest box prints a
  pairing code when it starts, which you enter under **Shack → Remote box**.
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
   your instance — back up the D1/SQLite database ([Backups](#backups)).

## Backups

- **Self-host and Desktop (SQLite):** cron `deploy/backup.sh`. It takes a consistent SQLite `.backup`
  snapshot, gzips it, and uploads it to `BACKUP_DIR`, an OCI bucket or any S3-compatible endpoint (see
  `deploy/.env.example`); it exits non-zero when no destination is set. Uploaded cache media is stored as files (`MEDIA_DIR`),
  not in the database — include that directory in your host backup.
- **Pocket (Termux on a phone):** `deploy/pocket/backup.sh` takes the same kind of consistent snapshot
  (SQLite's online backup, through better-sqlite3) and writes it, with the `.env` and the media, to the
  phone's shared storage, keeping the newest seven; `--no-env` leaves the secrets out.
- **Cloudflare split (D1 + R2):** `backup.sh` does not apply. D1 has **Time Travel**, a point-in-time restore
  that is always on and costs nothing extra: any minute of the last **30 days on Workers Paid** (7 days on
  Workers Free) — per Cloudflare's
  [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/) page, checked
  2026-09-30.

    ```bash
    cd workers/gateway
    npx wrangler d1 time-travel info aprscaching                                  # the current bookmark
    npx wrangler d1 time-travel info aprscaching --timestamp=2026-09-29T03:00:00Z  # the bookmark for a past moment
    npx wrangler d1 time-travel restore aprscaching --timestamp=2026-09-29T03:00:00Z
    npx wrangler d1 time-travel restore aprscaching --bookmark=<bookmark>          # undo: restore the bookmark the last restore printed
    ```

    A restore overwrites the database in place and cancels in-flight queries; it prints the previous
    bookmark, so a restore can itself be undone. For history older than the retention window, keep a nightly
    SQL dump as well:
    `npx wrangler d1 export aprscaching --remote --output backup-$(date +%F).sql` from any box with a
    Cloudflare API token.

    Time Travel covers D1 only. The **R2 media** bucket (`aprscaching-media`: audio clues and cache media)
    needs its own backup plan — for example a nightly `rclone sync` from R2's S3-compatible endpoint to other
    storage, or `npx wrangler r2 object get aprscaching-media/<key> --remote --file <key>` for single
    objects.

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
