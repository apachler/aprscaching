# Website teaser tooling

Reproducible marketing teaser for aprscaching.com: seeds a demo dataset, drives the **live
app** with Playwright, and composes a brand-styled poster. Outputs land in `out/`.

```
out/01-map.png      live cache map (offline grid basemap)
out/02-detail.png   cache detail + logbook with trust-tier badges
out/03-hide.png     hide-a-cache flow
out/04-mobile.png   mobile detail view
out/teaser.png      the composed poster (hero)
```

## One command

```bash
tools/teaser/run.sh
```

It builds the web app with the self-contained offline grid basemap (`VITE_BASEMAP=offline`,
so no tile CDN is needed), resets a **local** D1, starts `wrangler dev` + `vite preview`,
seeds demo caches/logs, crawls the states, and renders `out/teaser.png`. Background servers
are torn down on exit. Re-run any time — it resets the local demo DB first.

## Prerequisites

- Repo deps installed once at the root: `pnpm install`
- A Chromium for Playwright:
  - **This sandbox:** prebuilt at `/opt/pw-browsers` (auto-detected via `PW_CHROMIUM`).
  - **Elsewhere:** `cd tools/teaser && npm install && npx playwright install chromium`,
    then leave `PW_CHROMIUM` unset so Playwright resolves its own browser.

## Run the steps individually

```bash
cd tools/teaser && npm install                 # playwright
# (start `wrangler dev` and `vite preview` yourself, or use run.sh)
API_BASE=http://127.0.0.1:8787  node seed.mjs   # demo caches + a rich logbook
BASE=http://127.0.0.1:4173 OUT=./out node shoot.mjs
OUT=./out node teaser.mjs                        # needs the brand assets copied into out/
```

## Knobs

| env | default | meaning |
|-----|---------|---------|
| `PORT_API` / `PORT_WEB` | `8787` / `4173` | worker / preview ports |
| `API_BASE` | `http://127.0.0.1:8787` | worker base for seeding |
| `BASE` | `http://127.0.0.1:4173` | app base for the crawl |
| `OUT` | `tools/teaser/out` | screenshot output dir |
| `PW_CHROMIUM` | `/opt/pw-browsers/chromium` if present | Chromium executable |
| `INGEST_SECRET` | `change-me` | matches `wrangler.toml` (for the Tier-A RF seed) |

Edit the cache list / logbook in `seed.mjs`, the captured states in `shoot.mjs`, and the
poster layout in `teaser.html`.
