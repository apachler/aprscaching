# deploy/

Provisioning assets for the three deployment shapes — **Self-host** (recommended), **Desktop** and
**Cloudflare split** (below). Principle: the **RF ingest always runs on the operator's own equipment** — a local process *or* the
browser (Web Serial/BLE); the gateway/core is the variable.

## Files
| File | Purpose |
|---|---|
| `aprscaching` | one command for every shape: `init`, `status`, `backup`, `rotate-secret`, … (`docs/operate/helpers.md`) |
| `lib/` | the helpers' shared shell library, a module per shape, and the configuration schema's export (`config-keys.tsv`, generated) |
| `setup.sh` | first-run wizard: writes `.env` (operator call, `APP_URL`, APRS-IS feed, site call, secrets, federation key); safe to re-run; `--non-interactive` for scripts |
| `desktop/` | **Desktop** — single-binary app (Bun `--compile`); see `desktop/README.md` |
| `pocket/` | the gateway and the ingest on an Android phone in Termux (a field-day station); see `pocket/README.md` |
| `Dockerfile` | multi-arch (amd64+arm64) image for gateway + ingest |
| `docker-compose.yml` | **Self-host** stack: gateway + ingest + Caddy |
| `compose.home.yml` | self-host override: Cloudflare Tunnel ingress (no open ports) |
| `compose.ingest-only.yml` | operator RF box → a remote gateway (the **Cloudflare split**, or any gateway elsewhere) |
| `.env.example` | all config with sane defaults (generated from the schema by `tools/config/generate.mjs`) |
| `Caddyfile` | TLS + SPA + reverse proxy |
| `cloudflared/config.yml` | named-tunnel ingress (alternative to `TUNNEL_TOKEN`) |
| `systemd/*.service` | bare-metal alternative to Docker |
| `oci/main.tf`, `oci/schema.yaml`, `oci/cloud-init.yaml`, `oci/README-stack.md` | OCI one-click self-host stack (published per release by `scripts/build-oci-stack.sh`) |
| `cloudflare/deploy-cf.sh` | **Cloudflare split** one-shot (D1/R2/Worker/Pages) |
| `cloudflare/cache-rules.sh` | self-host behind Cloudflare's CDN: cache/bypass rules |
| `backup.sh` | SQLite snapshot → object storage (cron); the Cloudflare split uses D1 Time Travel instead |

## Quick start per shape
```bash
# Self-host, recommended (a Pi, mini-PC or VM): the wizard asks how people reach the box —
#   Caddy with TLS · a Cloudflare Tunnel · the LAN only (off-grid) — and prints the next commands
./setup.sh
docker compose up -d --build                                            # Caddy with TLS, or LAN
docker compose -f docker-compose.yml -f compose.home.yml up -d --build  # Cloudflare Tunnel
#   optional CDN in front of a public box: restrict 80/443 to Cloudflare's ranges, set TRUST_CF=1, then
CF_API_TOKEN=… CF_ZONE_ID=… ./cloudflare/cache-rules.sh

# Desktop (no Node/Docker): build executables for every OS from one machine
bash desktop/build-exe.sh v1.0.0

# Cloudflare split (Worker + D1 + R2 + Pages) with the RF ingest on your own box
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
- **Self-host and Desktop (SQLite):** `backup.sh` takes a consistent `.backup` snapshot, gzips it, and
  uploads to `BACKUP_DIR` / an OCI bucket / any S3-compatible endpoint (see `.env.example`). Cron it, and
  include `MEDIA_DIR` (uploaded cache media) in the host backup.
- **Pocket (Termux on a phone):** `pocket/backup.sh` writes the snapshot, the `.env` and the media to the
  phone's shared storage and keeps the newest seven (see `pocket/README.md`).
- **Cloudflare split (D1 + R2):** `backup.sh` does not apply. D1 Time Travel is always on and restores the
  database to any minute of the last 30 days on Workers Paid (7 days on Workers Free), per
  https://developers.cloudflare.com/d1/reference/time-travel/ (checked 2026-09-30):
  `npx wrangler d1 time-travel info aprscaching --timestamp=2026-09-29T03:00:00Z` shows the bookmark for a
  moment, and `npx wrangler d1 time-travel restore aprscaching --timestamp=2026-09-29T03:00:00Z` restores it
  (run from `workers/gateway`; it overwrites the database in place and prints the bookmark that undoes it).
  For history beyond the window, cron
  `npx wrangler d1 export aprscaching --remote --output backup-$(date +%F).sql` on any box with a Cloudflare
  API token. R2 media (`aprscaching-media`) is not covered by Time Travel and needs its own plan — e.g. a
  nightly `rclone sync` from R2's S3-compatible endpoint, or `npx wrangler r2 object get
  aprscaching-media/<key> --remote --file <key>` for single objects. Details:
  `docs/operate/deployment.md` → Backups.
