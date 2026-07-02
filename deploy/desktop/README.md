# deploy/desktop — single-binary desktop app (Topology 0)

A self-contained executable (built with `bun build --compile`) bundling the **gateway + SPA +
optional local ingest**. Download one file, run it: it starts a local server, opens your browser,
and keeps SQLite in your OS app-data dir. RF comes from the **browser (Web Serial/BLE)** or the
bundled ingest — operator-local, per `.claude/rules/ingest-locality.md`. Works off-grid; it's a
federation peer like any other instance.

## Files
| File | Purpose |
|---|---|
| `launcher.ts` | entry point: run migrations → start gateway (`handle()`) → serve the embedded SPA → open browser → SQLite in app-data |
| `gen-assets.ts` | build step: embeds `apps/web/dist` + `db/migrations` into the binary (`import … with { type: "file" }`) → `assets.generated.ts` (gitignored) |
| `db-bun-sqlite.ts` | re-exports the conformance-tested `bun:sqlite` adapter (`servers/bun/d1.ts`) |
| `appdata.ts` | per-OS data directory resolver |
| `build-exe.sh` | cross-compile the matrix from one machine (web build → embed → `bun build --compile`) |
| `entitlements.plist` | macOS JIT entitlements for codesigning |
| `../../.github/workflows/desktop-release.yml` | CI: build matrix + attach to a tagged release |

## How it works (done)
The launcher reuses the **runtime-neutral gateway** (`handle()` from `@aprsweb/gateway`) and the Bun
adapters (`servers/bun/{d1,migrate,media,rooms,gateway}.ts` — the same code the Bun conformance lane
exercises), so the desktop core is the *identical* business logic as the Worker and Node runtimes. At
build time `gen-assets.ts` embeds the built SPA + SQL migrations into the executable; the launcher
applies migrations on first run, routes dynamic paths through `handle()` and serves everything else as
the SPA (router-fallback to `index.html`), and keeps SQLite in the OS app-data dir. `bun run
launcher.ts` in the repo gives a disk-backed dev run (no embed needed). RF is browser Web Serial/BLE
(operator-local); an always-on local feed is `apps/ingest`, run separately. *Validated: the compiled
linux-x64 binary serves the embedded SPA + gateway + migrations from an isolated dir.*

## Build (one machine → all platforms)
```bash
bash deploy/desktop/build-exe.sh v1.0.0
# -> dist/desktop/aprscaching-{windows-x64.exe, macos-arm64, macos-x64, linux-x64, linux-arm64}
```

## Run & data location
Double-click or `./aprscaching-linux-x64`. SQLite lives in:
- Windows: `%APPDATA%\aprscaching`
- macOS: `~/Library/Application Support/aprscaching`
- Linux: `~/.local/share/aprscaching`

Back that file up (`deploy/backup.sh`).

## Signing (for a smooth UX)
Unsigned binaries trip macOS Gatekeeper and Windows SmartScreen.
- **macOS:** `codesign --deep --force -s "Developer ID Application: <YOU>" --options runtime \
  --entitlements deploy/desktop/entitlements.plist dist/desktop/aprscaching-macos-arm64`, then
  notarize with `notarytool`. (Requires an Apple Developer ID; cross-compiled mac binaries are
  signed on a mac.)
- **Windows:** sign with an Authenticode code-signing certificate (`signtool`).

## Caveats
"One exe" = **one binary per OS/arch** (cross-built from a single machine), ~50–100 MB each (the Bun
runtime is inside). The desktop app is a single-user local instance — for shared/always-on use, see
the other topologies in `docs/design/23-deployment.md`.
