# Running in Docker

The `deploy/` directory ships a complete Docker stack: one multi-arch image (amd64 + arm64) that
contains the Node gateway, the ingest, and the built web app, plus compose files for the common
deployment shapes. Everything below runs from a plain `git clone` — no host Node/pnpm install needed.

## The image

`deploy/Dockerfile` builds from the repo root: it installs the workspace with the pinned pnpm,
builds every package (including the web SPA into `apps/web/dist` **inside the image**), and defaults
to starting the gateway. The same image runs the ingest via a compose `command:` override.

```bash
docker build -f deploy/Dockerfile -t aprscaching:local .
```

## Full stack (gateway + ingest + web + TLS)

This is the [Self-host](deployment.md#self-host) shape — the recommended one: one box, any VM, VPS, Pi or mini-PC.

```bash
cd deploy
./setup.sh                             # writes .env; prints the start, health and verify commands for your choice
docker compose up -d --build
docker compose ps                      # the gateway shows "healthy" once it is ready
curl -fsS https://<your domain>/health # off-grid: http://<LAN address>/health (Caddy publishes 80/443; the gateway's 8080 is internal)
```

`setup.sh` asks for your callsign, the APRS-IS passcode and filter, how people reach the box, and an RF
site call, then writes `ADMIN_CALLSIGNS`, `APP_URL`, `DOMAIN`, `APRSIS_*`, `RF_SITE_CALL` +
`FIRST_PARTY_SITES`, `INGEST_SECRET`, `OPERATOR_SECRET` and `FED_PRIVATE_KEY`. A value already in `.env` is
kept unless you confirm the change, so re-running it is safe. For scripts: `./setup.sh --non-interactive
--call OE8APR --domain aprs.example.net` (`--help` lists every flag).

Every setting in `deploy/.env` reaches both the gateway and the ingest container, so the whole
[first-hour checklist](first-hour.md) — `ADMIN_CALLSIGNS`, `FIRST_PARTY_SITES`, `OPERATOR_*`,
`SOURCE_REPO`, federation keys — and every [radio transport](rf-ingest.md) setting is configured there.
Restart with `docker compose up -d` after changing it.

What comes up:

| Service | Role | Notes |
|---|---|---|
| `gateway` | Node + SQLite gateway on `:8080` inside the stack (not published; Caddy proxies to it) | DB in the `data` volume; healthcheck on `/health`; **requires `INGEST_SECRET`** (it refuses to boot with the default — `setup.sh` generates one); also takes `OPERATOR_SECRET` and `SESSION_SECRET` (an empty session secret is generated into the `data` volume) |
| `ingest` | APRS-IS (and optional RF) feed | Waits for the gateway healthcheck; config from `.env`, with `OPERATOR_SECRET`, `SESSION_SECRET` and `FED_PRIVATE_KEY` blanked — the ingest box holds only `INGEST_SECRET` |
| `webdist` | one-shot | Copies the SPA built inside the image into the volume Caddy serves (a fresh clone has no host `apps/web/dist` — it is gitignored) |
| `caddy` | TLS + SPA + reverse proxy | `DOMAIN=:80` = plain HTTP (local/off-grid); `DOMAIN=your.host` = automatic Let's Encrypt |

Operational defaults baked into the compose file: `restart: unless-stopped` on every long-running
service, JSON log caps (~30 MB retained per service), and a gateway healthcheck other services and
your uptime monitoring can key off.

### Cloudflare Tunnel ingress (a Pi or mini-PC at home)

No port-forwarding, no static IP, CGNAT-friendly — the Pi opens an outbound connection to
Cloudflare and your domain rides it. You need a (free) Cloudflare account with your domain's DNS
on it.

1. **Create the tunnel.** In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels →
   Create a tunnel** → connector type *Cloudflared* → name it (e.g. `aprscaching-pi`). On the
   "Install connector" step, copy the long token from the shown command — that is the
   `TUNNEL_TOKEN`. (Don't run their install command; the compose stack runs the connector.)
2. **Give the token to the stack.** Run `./setup.sh`, choose the Cloudflare Tunnel, and paste the token
   and your hostname: it writes `TUNNEL_TOKEN`, `APP_URL=https://<hostname>` and `DOMAIN=:80` — TLS
   terminates at Cloudflare's edge, so Caddy serves plain HTTP inside the stack and must not try to fetch
   a certificate.
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
   answers `ok`, and the SPA loads. Continue with [Your first hour as sysop](first-hour.md).

### The operator RF box for a remote gateway

In the [Cloudflare split](deployment.md#cloudflare-split) — or beside any gateway on another host — only the
ingest runs locally (the RF ingest is always operator-local):

```bash
INGEST_URL=https://api.your.host/ingest docker compose -f compose.ingest-only.yml up -d --build
```

The same stack doubles as a **cloud APRS-IS feed**: on any VM (e.g. OCI), set only the `APRSIS_*`
variables and point `INGEST_URL` at the instance — a baseline global feed from day one. Keep such a
box IS-only: RF transports always belong on the operator's own equipment.

### Off-grid

Choose the LAN option in `./setup.sh`: `DOMAIN=:80`, `APP_URL=http://<LAN address>`, and the default
`INGEST_URL=http://gateway:8080/ingest` — the full map + RF stack with no internet at all. Without https
there are no passkeys, so members sign in with the operator's
[one-time link](first-hour.md#off-grid-sign-in).

## RF hardware from a container

A KISS TNC over TCP (`KISS_TNC_HOST`), AGWPE (Direwolf/SoundModem), and hostmode all reach the
ingest container over the network — run the TNC software on the host (or another box) and point the
env vars at it. From inside the container the host is not `localhost`: use the host's LAN address.
For AXUDP no special privileges are needed. The AXIP transport (raw IP protocol 93) needs
`CAP_NET_RAW`; add `cap_add: [NET_RAW]` to the ingest service if you use it.

**MeshCom** nodes send UDP to port 1799 on the box, so the ingest container has to receive it. In
`docker-compose.yml` (or `compose.ingest-only.yml`) un-comment the `ports:` line on the ingest service and
put your host's LAN address in it, then set `MESHCOM_BIND=0.0.0.0` in `.env` — inside the container that
is only the container's own interface, and the published port exposes it on your LAN address alone. See
[MeshCom](meshcom.md).

## Upgrades, backups, logs

- **Upgrade:** `git pull && docker compose up -d --build` — migrations apply automatically at
  gateway boot (forward-only, tracked in `_migrations`).
- **Backup:** cron `deploy/backup.sh` — a consistent SQLite `.backup` snapshot, gzipped, uploaded
  to a directory / OCI bucket / any S3-compatible endpoint (see `deploy/.env.example`). It exits
  non-zero if no destination is configured, so a misconfigured cron cannot silently no-op. The
  Cloudflare split backs up with D1 Time Travel instead — see [Backups](deployment.md#backups).
- **Logs:** `docker compose logs -f gateway` (rotation is capped by the compose logging options).

## Standalone images

Two single-service Dockerfiles exist for mix-and-match setups: `servers/node/Dockerfile` (gateway
only) and `apps/ingest/Dockerfile` (ingest only). Both build from the repo root.

## What Docker does NOT cover

- The **desktop** app is a Bun single binary — `deploy/desktop/`, no container.
- The **Cloudflare** core is Workers/D1/R2 — deployed with `deploy/cloudflare/deploy-cf.sh`
  (wrangler), not Docker. Back up D1 with `wrangler d1 export` (see `deploy/README.md`).
- The **interop test peers** under `tools/interop/` have their own compose file and are test
  infrastructure, not deployment.
