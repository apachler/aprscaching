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
   leaderboard → profile → shack → BBS → settings.
6. **Assembles the video** (`build-video.sh` → `compose.mjs`): frames letterboxed onto a uniform
   1920×1080 canvas, captioned per step, crossfaded between steps. Background servers are torn down
   on exit.

> Composition runs **in Chromium** (canvas + MediaRecorder), not ffmpeg: the Playwright-bundled
> ffmpeg is a minimal screencast build (no PNG decode, no drawtext/fade), so we record the canvas
> stream to webm directly. No ffmpeg dependency.

### Output (git-ignored — generated artifacts)

- `tour/aprscaching-ui-teaser.webm` — the teaser video.
- `tour/[123]-NN-<view>-<step>.png` — ordered frames (prefix `1/2/3` = desktop/tablet/mobile).
- `tour/manifest-<view>.json` — frame → label map.

### Pieces (run individually)

| File | Role |
|---|---|
| `run-tour.sh` | One-shot orchestrator (build → serve → seed → tour → video). **Start here.** |
| `tour.mjs` | Playwright driver. One viewport per process via `VIEW=desktop\|tablet\|mobile`. |
| `build-video.sh` | Thin wrapper → `compose.mjs`. |
| `compose.mjs` | Frames → captioned `.webm` via Chromium canvas + MediaRecorder (`HOLD`, `FADE` env knobs). |
| `run-views.sh` | Re-run just the tour (all viewports) against already-running servers. |
| `diag.mjs` | Minimal load/console diagnostic for one viewport (debugging). |

### What's automatic vs. maintained

- **Page appearance & content** — automatic. Every shot is taken against the freshly-built live app,
  so styling, layout, copy, new fields, new badges, etc. show up next run with no tooling change.
  Data-driven content follows `seed.mjs`.
- **The set of top-level pages** — **auto-discovered.** Desktop enumerates the `NavRail` at runtime;
  tablet/mobile enumerate the `Profile → Advanced` tools (their deliberate home for extra pages). A
  newly added destination is captured **without editing the tour**.
- **Interaction-gated dialogs** (filter, cache detail, hide-a-cache) and the journey *order* — these
  stay scripted as `step(...)` calls. Only a brand-new *dialog* needs a new `step`.
- **Navigation contract** — discovery keys off the rail `button[title]`, the `.nav-desktop` / `.tabbar`
  primary buttons, and emoji/glyph-prefixed buttons under the Advanced disclosure. Rename those
  patterns and the matching step skips (logged), so the contract is the only thing to keep in sync.

### Notes

- Readiness keys off the MapLibre canvas paint (`.maplibregl-canvas`), not pins — reliable
  regardless of where caches sit in the viewport.
- Breakpoints: `NavRail` ≥1024px (desktop) · `.topbar .nav-desktop` 681–1023px (tablet) · `.tabbar`
  ≤680px (mobile).
- **Do not** `pkill` on the chrome path between viewports — that pattern also matches the
  orchestrator's own command line and self-kills the run. `tour.mjs` closes its own browser.

---

## 2. Brand poster — `run.sh`

```bash
tools/teaser/run.sh
```

Builds the web app (offline basemap), resets a **local** D1, starts `wrangler dev` + `vite
preview`, seeds demo caches/logs, crawls the states, and renders `out/teaser.png` (+ the
per-surface `.mjs` composers: `board`, `bbs`, `settings`, `shack`, …). Servers torn down on exit.

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
- Video assembly needs **no ffmpeg** — it composes in Chromium (the same browser the tour uses).

## Knobs

| env | default | meaning |
|-----|---------|---------|
| `PORT_API` / `PORT_WEB` | `8799` / `4199` (tour) · `8787` / `4173` (poster) | gateway / preview ports |
| `API_BASE` | `http://127.0.0.1:<PORT_API>` | gateway base for seeding |
| `BASE` | `http://127.0.0.1:<PORT_WEB>` | app base for the crawl |
| `VIEW` | all | tour viewport: `desktop` / `tablet` / `mobile` |
| `HOLD` / `FADE` | `2.4` / `0.45` | video per-step seconds / crossfade seconds |
| `PW_CHROMIUM` | `/opt/pw-browsers/chromium` if present | Chromium executable |
| `INGEST_SECRET` | `change-me` | matches the gateway secret (for the Tier-A RF seed) |

The `tour/` and `out/` directories are git-ignored; only the tooling is tracked.
