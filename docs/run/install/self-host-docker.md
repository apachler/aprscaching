# Self-host with Docker

The `deploy/` directory ships a complete Docker stack: one multi-arch image (amd64 + arm64) that
contains the Node gateway, the ingest, and the built web app, plus compose files for the common
deployment shapes. Everything below runs from a plain `git clone` — no host Node/pnpm install needed.

**With the helper:** `deploy/aprscaching init selfhost` (or `init baremetal` without Docker), then
`deploy/aprscaching doctor` — see [The deploy/aprscaching command](../day-to-day/helper-command.md). The manual steps follow.

The recommended shape. The Docker stack (`deploy/docker-compose.yml`: gateway, ingest, Caddy) runs on anything
that runs Docker — a Pi at home, a mini-PC, an OCI or other cloud VM. `deploy/setup.sh` writes its whole
configuration and asks how people reach it:

- **Caddy with TLS** — a public hostname, ports 80 and 443 open; Caddy fetches the certificate.
- **Cloudflare Tunnel** — no open ports, no static IP (home connections, CGNAT); `compose.home.yml` adds the
  connector.
- **LAN / off-grid** — plain http on the local network, no internet needed; members sign in with the
  operator's [one-time link](../day-to-day/sign-in-links.md#off-grid-sign-in).

Oracle
Cloud users can start the same stack with the
[one-click OCI stack](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip):
one Always-Free A1 VM within an Always-Free-only tenancy's allowance (2 OCPUs and 12 GB since mid-2026), a
reserved public IP, and SSH only through OCI Bastion. Its first boot installs Docker from Docker's signed apt
repository, deploys the release's checked commit through `deploy/aprscaching init selfhost`, and generates the
secrets on the VM (`deploy/oci/README-stack.md`).

**Staying on the free tier.** Oracle may reclaim an Always Free A1 instance that stays idle for seven days
(CPU, network and memory all under 20 %), and may suspend a free account unused for 30 days
([Free Tier FAQ](https://www.oracle.com/cloud/free/faq/), as of 1 October 2026). Upgrade the tenancy to Pay
As You Go and set a budget alert: Always Free resources stay free, and the instance is not reclaimed. The
stack runs Docker Compose on the VM; Container Instances and Kubernetes do not suit one SQLite instance on
the free tier (`deploy/oci/README-stack.md`, *Staying on the free tier*).

Bare metal without Docker: `deploy/aprscaching init baremetal` installs the same gateway and ingest from a
checkout under systemd, as a dedicated system user, with the gateway serving the web app on its own port
(see [Self-host without Docker](self-host-bare-metal.md)). The units it installs are `deploy/systemd/`'s.

## Before you start

- **A Linux box** — a Pi, a mini-PC or a VM — with Docker Engine and the Compose plugin
  (`docker compose version` answers).
- **The repository:** `git clone https://github.com/apachler/aprscaching && cd aprscaching`.
- **Your callsign and APRS-IS passcode** — `setup.sh` asks for both.
- **How people reach the box**, one of:
    - a DNS name pointing at the box, with ports **80 and 443** reachable from the internet (Caddy gets the
      TLS certificate from Let's Encrypt);
    - a [Cloudflare Tunnel](../networks/cloudflare.md#set-up-the-tunnel) — no inbound port at all;
    - your LAN only ([off-grid](../networks/off-grid.md#off-grid-with-docker)), plain HTTP on port 80.

!!! warning "Open only what the stack needs"
    Caddy publishes 80 and 443; the gateway's port 8080 stays inside Docker. On a public box, let the
    firewall admit only 80 and 443 (and SSH from addresses you trust) — never the gateway port or an ingest
    port.

## The image

`deploy/Dockerfile` builds from the repo root: it installs the workspace with the pinned pnpm,
builds every package (including the web SPA into `apps/web/dist` **inside the image**), and defaults
to starting the gateway. The same image runs the ingest via a compose `command:` override.

```bash
docker build -f deploy/Dockerfile -t aprscaching:local .
```

## Full stack (gateway + ingest + web + TLS)

This is the [Self-host](self-host-docker.md) shape — the recommended one: one box, any VM, VPS, Pi or mini-PC.

```bash
cd deploy
./setup.sh                             # writes .env; prints the start, health and verify commands for your choice
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build   # the commit names the source link's code
docker compose ps                      # the gateway shows "healthy" once it is ready
curl -fsS https://<your domain>/health # off-grid: http://<LAN address>/health (Caddy publishes 80/443; the gateway's 8080 is internal)
```

`setup.sh` asks for your callsign, the APRS-IS passcode and filter, how people reach the box, and an RF
site call, then writes `ADMIN_CALLSIGNS`, `APP_URL`, `DOMAIN`, `APRSIS_*`, `RF_SITE_CALL` +
`FIRST_PARTY_SITES`, `INGEST_SECRET`, `OPERATOR_SECRET` and `FED_PRIVATE_KEY`. A value already in `.env` is
kept unless you confirm the change, so re-running it is safe. For scripts: `./setup.sh --non-interactive
--call OE8APR --domain aprs.example.net` (`--help` lists every flag). `deploy/aprscaching init selfhost` runs
the same wizard and records the shape for the other [helper commands](../day-to-day/helper-command.md).

A public instance (a domain, with or without a tunnel) also gets the safe federation posture written out:
`FED_AUTO_PROMOTE=0`, `FED_CORROBORATION_QUORUM=2` and `FED_DISCOVER=0`. The wizard asks for the peers you know (`--fed-peers`, https only), refuses a
44Net peer there, since a listed peer starts `trusted` (onboard 44Net peers from Instance admin, which admits
them `unvetted`), and can add the instance's 44Net name to `FED_ENDPOINTS` (`--net44-name`). On a hub
(`FED_SUBMIT_SECRET` set) it requires the spoke list (`--fed-submit-instances`); with a registry it requires
the pinned authority key (`--fed-registry-key`). A value you chose stays, with a warning when it is unsafe. A
LAN instance starts with federation off. `D1_DAILY_WRITE_BUDGET=0` is written on every instance: SQLite costs
the same whatever it writes. See [Running federation safely](../federation/index.md#running-federation-safely).

Every setting in `deploy/.env` reaches both the gateway and the ingest container, so the whole
[first-hour checklist](../first-hour.md) — `ADMIN_CALLSIGNS`, `FIRST_PARTY_SITES`, `OPERATOR_*`,
`SOURCE_REPO`, federation keys — and every [radio transport](../radios/rf-ingest.md) setting is configured there.
Restart with `docker compose up -d` after changing it.

What comes up:

| Service | Role | Notes |
|---|---|---|
| `gateway` | Node + SQLite gateway on `:8080` inside the stack (not published; Caddy proxies to it) | DB and cache media (`/data/media`) in the `data` volume; healthcheck on `/health`; **requires `INGEST_SECRET`** (it refuses to boot with the default — `setup.sh` generates one); also takes `OPERATOR_SECRET` and `SESSION_SECRET` (an empty session secret is generated into the `data` volume) |
| `ingest` | APRS-IS (and optional RF) feed | Waits for the gateway healthcheck; config from `.env`, with `OPERATOR_SECRET`, `SESSION_SECRET` and `FED_PRIVATE_KEY` blanked — the ingest box holds only `INGEST_SECRET` |
| `webdist` | one-shot | Copies the SPA built inside the image into the volume Caddy serves (a fresh clone has no host `apps/web/dist` — it is gitignored) |
| `caddy` | TLS + SPA + reverse proxy | `DOMAIN=:80` = plain HTTP (local/off-grid); `DOMAIN=your.host` = automatic Let's Encrypt |

Operational defaults baked into the compose file: `restart: unless-stopped` on every long-running
service, JSON log caps (~30 MB retained per service), and a gateway healthcheck other services and
your uptime monitoring can key off.

## Upgrades, backups, logs

- **Upgrade:** `deploy/aprscaching update`, or by hand
  `git pull && SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`. The image cannot see `.git`,
  so `SOURCE_COMMIT` is how its source link names the commit it runs. Migrations apply automatically at
  gateway boot (forward-only, tracked in `_migrations`).
- **Backup:** cron `deploy/backup.sh` — a consistent SQLite `.backup` snapshot, gzipped, uploaded
  to a directory / OCI bucket / any S3-compatible endpoint (see `deploy/.env.example`). It exits
  non-zero if no destination is configured, so a misconfigured cron cannot silently no-op. A bucket
  destination is append-only and needs a lifecycle rule on its `db/` prefix, or `BACKUP_PRUNE_BUCKET=1`
  — see [Backups](../day-to-day/backups.md#what-to-back-up) for both. The Cloudflare split backs up with D1 Time Travel
  instead.
- **Logs:** `docker compose logs -f gateway` (rotation is capped by the compose logging options).

## Next

- [Your first hour](../first-hour.md).
