# deploy/

Provisioning assets for the three deployment topologies — **desktop**, **self-host** and **Cloudflare**
(below). Principle: the **RF ingest always runs on the operator's own equipment** — a local process *or* the
browser (Web Serial/BLE); the gateway/core is the variable.

## Files
| File | Purpose |
|---|---|
| `setup.sh` | first-run wizard: writes `.env` (operator call, `APP_URL`, APRS-IS feed, site call, secrets, federation key); safe to re-run; `--non-interactive` for scripts |
| `desktop/` | **Desktop** — single-binary app (Bun `--compile`); see `desktop/README.md` |
| `Dockerfile` | multi-arch (amd64+arm64) image for gateway + ingest |
| `docker-compose.yml` | **Self-host** stack: gateway + ingest + Caddy |
| `compose.home.yml` | self-host override: Cloudflare Tunnel ingress (no open ports) |
| `compose.ingest-only.yml` | operator RF box → a remote gateway (the **Cloudflare** topology, or any gateway elsewhere) |
| `.env.example` | all config with sane defaults |
| `Caddyfile` | TLS + SPA + reverse proxy |
| `cloudflared/config.yml` | named-tunnel ingress (alternative to `TUNNEL_TOKEN`) |
| `systemd/*.service` | bare-metal alternative to Docker |
| `oci/main.tf`, `oci/schema.yaml`, `oci/cloud-init.yaml`, `oci/README-stack.md` | OCI one-click self-host stack (published per release by `scripts/build-oci-stack.sh`) |
| `cloudflare/deploy-cf.sh` | **Cloudflare** one-shot (D1/R2/Worker/Pages) |
| `cloudflare/cache-rules.sh` | self-host behind Cloudflare's CDN: cache/bypass rules |
| `backup.sh` | SQLite snapshot → object storage (cron) |

## Quick start per topology
```bash
# Desktop (no Node/Docker): build executables for every OS from one machine
bash desktop/build-exe.sh v1.0.0

# Self-host (a Pi, mini-PC or VM): the wizard asks how people reach the box —
#   Caddy with TLS · a Cloudflare Tunnel · the LAN only (off-grid) — and prints the next commands
./setup.sh
docker compose up -d --build                                            # Caddy with TLS, or LAN
docker compose -f docker-compose.yml -f compose.home.yml up -d --build  # Cloudflare Tunnel
#   optional CDN in front of a public box: restrict 80/443 to Cloudflare's ranges, set TRUST_CF=1, then
CF_API_TOKEN=… CF_ZONE_ID=… ./cloudflare/cache-rules.sh

# Cloudflare (Worker + D1 + R2 + Pages) with the RF ingest on your own box
./cloudflare/deploy-cf.sh
INGEST_URL=https://api.example.net/ingest docker compose -f compose.ingest-only.yml up -d --build
```

After the first start, sign in and confirm your call:
`docker compose exec gateway node tools/admin/verify-call.mjs <CALL>` (off-grid, sign in first with
`docker compose exec gateway node tools/admin/signin-link.mjs <CALL>`). The full order is in
`docs/operate/first-hour.md`.

The ingest-only stack is also a **day-one APRS-IS feed**: run it on a cloud VM with only the `APRSIS_*`
variables set (no RF transports) and `INGEST_URL` pointing at the instance. A cloud box may carry an IS-only
feed like this — the RF ingest itself always stays on the operator's own equipment
(`.claude/rules/ingest-locality.md`). Every instance MUST expose the AGPL §13 Source link and back up its DB
on a schedule.

## Backups
- **Desktop and self-host (SQLite):** `backup.sh` takes a consistent `.backup` snapshot, gzips it, and
  uploads to `BACKUP_DIR` / an OCI bucket / any S3-compatible endpoint (see `.env.example`). Cron it.
- **Cloudflare (D1):** `backup.sh` does not apply — D1 is exported with
  `wrangler d1 export aprscaching --remote --output backup-$(date +%F).sql` (cron it on any box with
  a Cloudflare API token), and Cloudflare's D1 Time Travel provides 30-day point-in-time restore as
  the second layer. R2 media should be replicated with `rclone` or an R2 lifecycle rule.
