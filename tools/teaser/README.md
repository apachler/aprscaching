# Website teaser tooling

Reproducible captures of the **current development state** of `apps/web`, driven against the
**live app** with Playwright over a throwaway local DB (offline grid basemap — no tile CDN, no
Cloudflare, no live data). Two outputs:

1. **UI/UX tour video** (`run-tour.sh`) — the primary teaser: every page + dialog, screenshotted
   at **desktop / tablet / mobile**, assembled into an ordered, captioned animation. Re-run any
   time to snapshot the UI as it evolves.
2. **Brand poster** (`run.sh`) — the original composed marketing hero (`out/teaser.png`).

---

## 1. UI/UX tour video — `run-tour.sh`  ← "build a new website teaser"

```bash
bash tools/teaser/run-tour.sh
```

One command, hermetic, against a fresh temp SQLite DB:

1. **Builds** `apps/web` with the offline grid basemap (`VITE_BASEMAP=offline`) + API base pointing
   at the local teaser gateway.
2. **Starts** a fresh Node gateway (`servers/node`) on `:8799` with a temp DB.
3. **Seeds** a Graz/Styria demo dataset (`seed.mjs`) — caches + a rich logbook (Tier A/B/C, DNF, note).
4. **Serves** the built SPA via `vite preview` on `:4199`.
5. **Runs the tour** (`tour.mjs`) once per viewport through a sane operator journey:
   landing → sign-in → map → filter → cache detail → hide-a-cache → nearby → activity →
   leaderboard → profile → workbench → BBS → settings.
6. **Assembles the video** (`build-video.sh`): frames letterboxed onto a uniform 1920×1080 canvas,
   captioned per step, faded between steps. Background servers are torn down on exit.

### Output (git-ignored — generated artifacts)

- `tour/aprscaching-ui-teaser.mp4` — the teaser video (+ a `.gif` preview).
- `tour/[123]-NN-<view>-<step>.png` — ordered frames (prefix `1/2/3` = desktop/tablet/mobile).
- `tour/manifest-<view>.json` — frame → label map.

### Pieces (run individually)

| File | Role |
|---|---|
| `run-tour.sh` | One-shot orchestrator (build → serve → seed → tour → video). **Start here.** |
| `tour.mjs` | Playwright driver. One viewport per process via `VIEW=desktop\|tablet\|mobile`. |
| `build-video.sh` | Frames → captioned mp4/gif via bundled ffmpeg (`HOLD`, `FADE` env knobs). |
| `run-views.sh` | Re-run just the tour (all viewports) against already-running servers. |
| `diag.mjs` | Minimal load/console diagnostic for one viewport (debugging). |

### Notes

- Readiness keys off the MapLibre canvas paint (`.maplibregl-canvas`), not pins — reliable
  regardless of where caches sit in the viewport.
- Desktop navigates via the `NavRail` (`.rail`); tablet/mobile via the top-bar / bottom `TabBar`.
  Add a `step(...)` in `tour.mjs` to capture a new surface.
- **Do not** `pkill` on the chrome path between viewports — that pattern also matches the
  orchestrator's own command line and self-kills the run. `tour.mjs` closes its own browser.

---

## 2. Brand poster — `run.sh`

```bash
tools/teaser/run.sh
```

Builds the web app (offline basemap), resets a **local** D1, starts `wrangler dev` + `vite
preview`, seeds demo caches/logs, crawls the states, and renders `out/teaser.png` (+ the
per-surface `.mjs` composers: `board`, `bbs`, `settings`, `workbench`, …). Servers torn down on exit.

```
out/01-map.png      live cache map (offline grid basemap)
out/02-detail.png   cache detail + logbook with trust-tier badges
out/03-hide.png     hide-a-cache flow
out/04-mobile.png   mobile detail view
out/teaser.png      the composed poster (hero)
```

---

## Prerequisites

- Repo deps installed once at the root: `pnpm install`.
- Chromium for Playwright:
  - **This sandbox:** prebuilt at `/opt/pw-browsers` (auto-detected via `PW_CHROMIUM`).
  - **Elsewhere:** `cd tools/teaser && npm install && npx playwright install chromium`, then leave
    `PW_CHROMIUM` unset so Playwright resolves its own browser.
- ffmpeg (video only): bundled at `/opt/pw-browsers/ffmpeg-*/ffmpeg-linux` (auto-detected; override
  with `FFMPEG=`). No system ffmpeg required.

## Knobs

| env | default | meaning |
|-----|---------|---------|
| `PORT_API` / `PORT_WEB` | `8799` / `4199` (tour) · `8787` / `4173` (poster) | gateway / preview ports |
| `API_BASE` | `http://127.0.0.1:<PORT_API>` | gateway base for seeding |
| `BASE` | `http://127.0.0.1:<PORT_WEB>` | app base for the crawl |
| `VIEW` | all | tour viewport: `desktop` / `tablet` / `mobile` |
| `HOLD` / `FADE` | `2.4` / `0.35` | video per-step seconds / crossfade seconds |
| `PW_CHROMIUM` | `/opt/pw-browsers/chromium` if present | Chromium executable |
| `FFMPEG` | bundled `/opt/pw-browsers/ffmpeg-*` | ffmpeg executable |
| `INGEST_SECRET` | `change-me` | matches the gateway secret (for the Tier-A RF seed) |

The `tour/` and `out/` directories are git-ignored; only the tooling is tracked.
