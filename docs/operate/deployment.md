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

Cost scales with rows written — see the cost table below.

#### Cost on D1

D1 bills **rows written**, and on this shape every packet your ingest forwards is written to D1. The cost
therefore scales with your APRS-IS filter and your RF traffic, not with your users. A self-hosted SQLite
database has no such meter: its cost is flat whatever the feed.

D1 counts each row an `INSERT`, `UPDATE` or `DELETE` writes, plus one row for each index entry an insert or
update writes. Cloudflare's price list ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked
2026-09-30):

| Plan | Rows written included | Beyond that |
|------|-----------------------|-------------|
| Workers Free | 100,000 per day (D1 queries fail once it is used up, until 00:00 UTC) | — |
| Workers Paid ($5 per month minimum) | 50 million per month | $1.00 per million |

**Rows written per packet.** The gateway's test suite pins these values, measured with the `rows_written`
counter of workerd's local D1 (`workers/gateway/test/d1_writes.test.ts`). They are the steady state: a station
and port already heard.

The gateway stores a position fix only when it says something new: the station has moved at least
`POS_MIN_MOVE_M` (25 m) since its last stored fix, or `POS_MIN_INTERVAL_S` (10 min) has passed. Every fix of a
**protected** station is stored, because verification reads them: a call an account holds or has verified
(any SSID), a registered station, a call with a find open (a find logged or a radio command sent in the last
30 minutes, or a radio command still pending), and the station of a living cache. So is every fix heard
directly on RF by your own TNC or MeshCom node, whatever the callsign. A fix that is not stored still reaches
the live map, watch alerts and rendezvous. A station that has not moved leaves its map position and registry
entry unrewritten.

| Packet | Written on ingest | Written by the nightly prune | Total |
|--------|-------------------|------------------------------|-------|
| Position fix, not stored (a station nothing protects that has not moved) | 6 | 1 | 7 |
| Position fix, stored, the station has not moved (protected, heard on RF, or the interval passed) | 11 | 2 | 13 |
| Position fix, stored, the station has moved | 12 | 2 | 14 |
| Position fix of a registered station that has moved | 13 | 2 | 15 |
| Position fix of a registered station that has not moved | 11 | 2 | 13 |
| Weather report with a position, not stored | 8 | 2 | 10 |
| Weather report with a position, stored | 13–14 | 3 | 16–17 |
| Weather report without a position | 8 | 2 | 10 |
| Message | 9 | 2 | 11 |
| Status, telemetry, anything else | 6 | 1 | 7 |

Every packet writes its row in the raw-packet ring (4 rows: the row, two indexes and the ID counter) and
its MHeard entry (2; a station heard several times in one batch writes it once). A stored position fix adds
the position history (4) and the station's latest position (1 when it has not moved, 2 when the position
index changes too). A station heard for the first time costs 2 more. On top of the per-packet rows, each
ingest batch adds 1 row per port for the hourly RX counter. The ingest posts a batch every 1.5 s
(`BATCH_MS`), so this adds at most 57,600 rows per day for each port. The nightly prune writes 1 row for each
row it deletes.

**Rows per day and per month.** The table below assumes a typical feed: 65 % position fixes, 10 % weather
with a position, 2 % weather without one, 3 % messages and 20 % other packets. It also assumes that half of
the position and weather fixes are not stored. A busy APRS-IS feed is mostly stations nothing protects —
digipeaters, IGates, weather stations, parked trackers — and many of them beacon from the same spot more
often than every 10 minutes; the protected stations (your own members and their finds) are a small share of
it. Your feed may thin more or less than that: a station beaconing every 10 minutes or slower is always
stored. The assumptions come to about 10 rows written per packet, counter rows and prune included; storing
every fix (`0`) makes it about 12. The table covers the ingest only; sign-ins, finds and federation add their
own writes on top.

| Feed | Packets per day | Rows written per day | Rows written per 30 days | Workers Free | Workers Paid per month |
|------|-----------------|----------------------|--------------------------|--------------|------------------------|
| 0.1 packets/s | 8,640 | ~96,000 | ~2.9 million | at the daily limit | $5 |
| 0.5 packets/s | 43,200 | ~480,000 | ~14 million | over | $5 |
| 1 packet/s | 86,400 | ~930,000 | ~28 million | over | $5 |
| 2 packets/s (the default filter, assumed) | 172,800 | ~1.8 million | ~54 million | over | ~$9 |
| 5 packets/s | 432,000 | ~4.4 million | ~133 million | over | ~$88 |
| 20 packets/s | 1.7 million | ~17.5 million | ~526 million | over | ~$481 |

The Free plan fits a feed of up to about 0.1 packets/s (about 9,000 packets a day): a single RF port or a
very small filter. Workers Paid covers about 1.8 packets/s within its included 50 million rows; every
further packet per second costs about $26 a month. Raising `POS_MIN_INTERVAL_S` or `POS_MIN_MOVE_M` thins
the unprotected stations further; `0` in either stores every fix.

The default filter in `.env.example`, `r/47.07/15.42/300`, is every station within 300 km of Graz. Its rate
in the table above is an assumption, not a measurement. Measure your own feed: `GET /api/ports` returns
each port's received packets over the last 24 hours (`{"window":"24h","ports":[{"port":"aprs-is","rx":…}]}`);
divide `rx` by 86,400 for packets per second. The Cloudflare dashboard (**D1 → your database → Metrics**)
shows the rows actually written.

This shape suits a small regional feed and an operator who wants no server to maintain. A large or
global feed belongs on [Self-host](#self-host), where the cost is flat.

#### Write budget

The Worker keeps a daily budget of D1 rows written, `D1_DAILY_WRITE_BUDGET`: **1,500,000** by default (the
Workers Paid allowance of 50 million a month, spread over 30 days). On Workers Free set it to **90000**, which
leaves a margin under the 100,000-row daily limit for sign-ins and finds. `0` turns the guard off. The count
covers every write the gateway makes, the nightly prune included, and starts again at 00:00 UTC, when
Cloudflare's own daily limits reset.

As the day's count nears the budget, the gateway stops storing the writes that matter least:

| Level | From | What is no longer stored |
|-------|------|--------------------------|
| ok | — | nothing: everything is stored as configured |
| warn | 80 % | the raw packet log (`packets_recent`), so the shack's raw packet view goes quiet (the Setup checklist's "Ingest feeding" line says why); a stationary station nothing protects stores a fix every `POS_MIN_INTERVAL_S` × 6 (an hour by default) instead of every interval, so its last-heard time can trail by that much |
| over | 100 % | also every fix and station update of a station nothing protects heard over APRS-IS, weather readings, messages that no protected call sends or receives, MHeard entries of stations your own receiver did not hear, and the hourly port counters |

**Protected data is never throttled.** At every level the gateway stores every fix of a protected station and
every fix heard directly on RF, every find and radio command (the message to the service call is still read as
a command and kept), a message to or from a protected call, account and key data, watch alerts, and
everything federation brings in, tombstones included. The nightly prune runs whatever the level: its deletes
count toward the budget, but it only ever shrinks the tables. A fix that is not stored still reaches the live
map, watch alerts and rendezvous.

The sysop hears about each threshold once per UTC day: a banner at the top of **Instance admin** (with the
count, which the Setup checklist's "D1 write budget" line also shows every day), and a line in the nightly
email digest to the address of every account that holds a control-verified `ADMIN_CALLSIGNS` call, when
email is configured. `GET /api/admin/setup` returns the same `budget: { used, budget, level, alerts }`
(sysop only).

The counter lives in the live-map Durable Object, which every Worker isolate shares, so reading the level
costs no D1 query: the ingest hands each batch's written rows to it with the live dispatch it already sends,
and gets the level back for the next batch. The object keeps the day's total in memory and writes it to its
own storage at most once a minute, plus once for each alert raised or mailed: at most about 1,440 storage
writes a day. SQLite-backed Durable Object storage is billed apart from D1, at the same rates (Workers Paid:
50 million rows written a month included, then $1.00 per million; Workers Free: 100,000 a day —
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), checked
2026-09-30), so the counter's own writes are negligible. When the object restarts it resumes from the last
stored total and may miss up to a minute of writes. On the Node and Bun runtimes the guard is off unless
`D1_DAILY_WRITE_BUDGET` is set; there the count is kept in memory, starts again when the server restarts, and
counts changed rows only (SQLite reports no index rows), so it runs low.

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
