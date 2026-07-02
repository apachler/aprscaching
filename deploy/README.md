# deploy/

Provisioning assets for the four deployment topologies (see ``). Principle:
the **RF ingest always runs on the operator's own equipment** — a local process *or* the browser
(Web Serial/BLE); the gateway/core is the variable.

## Files
| File | Purpose |
|---|---|
| `desktop/` | **Topology 0** — single-binary desktop app (Bun `--compile`); see `desktop/README.md` |
| `Dockerfile` | multi-arch (amd64+arm64) image for gateway + ingest |
| `docker-compose.yml` | base stack: gateway + ingest + Caddy (Topology 2 / any VPS) |
| `compose.home.yml` | override: Cloudflare Tunnel for a home Pi (Topology 1) |
| `compose.ingest-only.yml` | operator RF box → remote gateway (Topology 4 ingest) |
| `.env.example` | all config with sane defaults |
| `Caddyfile` | TLS + SPA + reverse proxy |
| `cloudflared/config.yml` | named-tunnel ingress (alternative to `TUNNEL_TOKEN`) |
| `systemd/*.service` | bare-metal alternative to Docker |
| `oci/cloud-init.yaml`, `oci/main.tf`, `oci/README-stack.md` | OCI one-click stack |
| `cloudflare/deploy-cf.sh` | Topology 4 one-shot (D1/R2/Worker/Pages) |
| `cloudflare/cache-rules.sh` | Topology 3 CDN cache/bypass rules |
| `setup.sh` | first-run wizard (writes `.env`, validates) |
| `backup.sh` | SQLite snapshot → object storage (cron) |

## Quick start per topology
```bash
cp .env.example .env && ./setup.sh          # fill callsign/passcode/filter/domain

# 0) Single-binary desktop (no Node/Docker): build exes for all OSes from one machine:
bash desktop/build-exe.sh v1.0.0

# 1) Pi at home (tunnel):
docker compose -f docker-compose.yml -f compose.home.yml up -d --build

# 2) OCI all-in-one (or any VPS):
docker compose up -d --build                # or one-click via oci/README-stack.md

# 3) OCI + Cloudflare CDN:
#    do (2), then add the domain to Cloudflare and:
CF_API_TOKEN=… CF_ZONE_ID=… ./cloudflare/cache-rules.sh

# 4) OCI ingest + Cloudflare Workers/D1/R2:
./cloudflare/deploy-cf.sh                    # managed core
docker compose -f compose.ingest-only.yml up -d --build   # operator RF box -> Worker
```
Off-grid: leave `DOMAIN=:80` and set `INGEST_URL=http://gateway:8080/ingest` — full local map + RF,
no internet. Every instance MUST expose the AGPL §13 Source link and run `backup.sh` on a schedule.

> Adjust the `pnpm --filter` package names in `Dockerfile`/compose/systemd to match your
> `package.json` if they differ from `@aprsweb/node-gateway` and `@aprsweb/ingest`.
