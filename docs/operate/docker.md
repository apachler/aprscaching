# Running in Docker

The `deploy/` directory ships a complete Docker stack: one multi-arch image (amd64 + arm64) that
contains the Node gateway, the ingest, and the built web app, plus compose files for the common
topologies. Everything below runs from a plain `git clone` — no host Node/pnpm install needed.

## The image

`deploy/Dockerfile` builds from the repo root: it installs the workspace with the pinned pnpm,
builds every package (including the web SPA into `apps/web/dist` **inside the image**), and defaults
to starting the gateway. The same image runs the ingest via a compose `command:` override.

```bash
docker build -f deploy/Dockerfile -t aprscaching:local .
```

## Full stack (gateway + ingest + web + TLS)

This is Topology 2 (all-in-one VM / any VPS) and the base for Topology 1 (home Pi behind a
Cloudflare Tunnel).

```bash
cd deploy
cp .env.example .env && ./setup.sh     # wizard: callsign, passcode, filter, domain; generates INGEST_SECRET
docker compose up -d --build
curl -fsS http://localhost:8080/health # gateway readiness
```

What comes up:

| Service | Role | Notes |
|---|---|---|
| `gateway` | Node + SQLite gateway on `:8080` | DB in the `data` volume; healthcheck on `/health`; **requires `INGEST_SECRET`** (it refuses to boot with the default — `setup.sh` generates one) |
| `ingest` | APRS-IS (and optional RF) feed | Waits for the gateway healthcheck; config from `.env` |
| `webdist` | one-shot | Copies the SPA built inside the image into the volume Caddy serves (a fresh clone has no host `apps/web/dist` — it is gitignored) |
| `caddy` | TLS + SPA + reverse proxy | `DOMAIN=:80` = plain HTTP (local/off-grid); `DOMAIN=your.host` = automatic Let's Encrypt |

Operational defaults baked into the compose file: `restart: unless-stopped` on every long-running
service, JSON log caps (~30 MB retained per service), and a gateway healthcheck other services and
your uptime monitoring can key off.

### Topology 1 — home Pi behind a Cloudflare Tunnel

No port-forwarding, no static IP, CGNAT-friendly — the Pi opens an outbound connection to
Cloudflare and your domain rides it. You need a (free) Cloudflare account with your domain's DNS
on it.

1. **Create the tunnel.** In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels →
   Create a tunnel** → connector type *Cloudflared* → name it (e.g. `aprscaching-pi`). On the
   "Install connector" step, copy the long token from the shown command — that is the
   `TUNNEL_TOKEN`. (Don't run their install command; the compose stack runs the connector.)
2. **Give the token to the stack.** In `deploy/.env`, set `TUNNEL_TOKEN=eyJh…` and
   `DOMAIN=:80` — TLS terminates at Cloudflare's edge, so Caddy serves plain HTTP inside the
   stack and must not try to fetch a certificate.
3. **Route your hostname.** Still in the tunnel dialog (or later under **Tunnels → your tunnel →
   Public hostnames**): add e.g. `aprs.example.net`, service type **HTTP**, URL `caddy:80`. The
   connector shares the compose network, so the service name resolves. Cloudflare creates the DNS
   record for you.
4. **Start it.**

    ```bash
    cd deploy
    docker compose -f docker-compose.yml -f compose.home.yml up -d --build
    ```

5. **Verify.** The tunnel shows *HEALTHY* in the dashboard, `https://aprs.example.net/health`
   answers `ok`, and the SPA loads. Set `APP_URL`/`RP_ID` in `.env` to the public hostname before
   anyone registers a passkey, then continue with
   [Your first hour as sysop](first-hour.md).

### Topology 4 — operator RF box feeding a remote gateway

Only the ingest runs locally (the RF ingest is always operator-local); the core is a Cloudflare
Worker or another remote gateway:

```bash
INGEST_URL=https://api.your.host/ingest docker compose -f compose.ingest-only.yml up -d --build
```

The same stack doubles as a **cloud APRS-IS feed**: on any VM (e.g. OCI), set only the `APRSIS_*`
variables and point `INGEST_URL` at the instance — a baseline global feed from day one. Keep such a
box IS-only: RF transports always belong on the operator's own equipment.

### Off-grid

Leave `DOMAIN=:80` and `INGEST_URL=http://gateway:8080/ingest` — the full map + RF stack with no
internet at all.

## RF hardware from a container

A KISS TNC over TCP (`KISS_TNC_HOST`), AGWPE (Direwolf/SoundModem), and hostmode all reach the
ingest container over the network — run the TNC software on the host (or another box) and point the
env vars at it. For AXUDP no special privileges are needed. The AXIP transport (raw IP protocol 93)
needs `CAP_NET_RAW`; add `cap_add: [NET_RAW]` to the ingest service if you use it.

## Upgrades, backups, logs

- **Upgrade:** `git pull && docker compose up -d --build` — migrations apply automatically at
  gateway boot (forward-only, tracked in `_migrations`).
- **Backup:** cron `deploy/backup.sh` — a consistent SQLite `.backup` snapshot, gzipped, uploaded
  to a directory / OCI bucket / any S3-compatible endpoint (see `deploy/.env.example`). It exits
  non-zero if no destination is configured, so a misconfigured cron cannot silently no-op.
- **Logs:** `docker compose logs -f gateway` (rotation is capped by the compose logging options).

## Standalone images

Two single-service Dockerfiles exist for mix-and-match setups: `servers/node/Dockerfile` (gateway
only) and `apps/ingest/Dockerfile` (ingest only). Both build from the repo root.

## What Docker does NOT cover

- **Topology 0** (desktop) is a Bun single binary — `deploy/desktop/`, no container.
- **Topology 4's core** is Cloudflare Workers/D1/R2 — deployed with `deploy/cloudflare/deploy-cf.sh`
  (wrangler), not Docker. Back up D1 with `wrangler d1 export` (see `deploy/README.md`).
- The **interop test peers** under `tools/interop/` have their own compose file and are test
  infrastructure, not deployment.
