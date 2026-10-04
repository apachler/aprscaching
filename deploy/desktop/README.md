# deploy/desktop — single-binary desktop app (the Desktop shape)

A self-contained executable (built with `bun build --compile`) bundling the **gateway + SPA +
optional local ingest**. Download one file, run it: it starts a local server, opens your browser,
and keeps SQLite in your OS app-data dir. RF comes from the **browser (Web Serial/BLE)** or the
bundled ingest — operator-local, per `.claude/rules/ingest-locality.md`. Works off-grid; it's a
federation peer like any other instance.

## Files
| File | Purpose |
|---|---|
| `launcher.ts` | entry point: resolve secrets → start the Bun gateway (`createServer` from `servers/bun/server.ts`) on `127.0.0.1` with the embedded SPA and migrations → open browser → SQLite in app-data |
| `gen-assets.ts` | build step: embeds `apps/web/dist` + `db/migrations` into the binary (`import … with { type: "file" }`) → `assets.generated.ts` (gitignored) |
| `appdata.ts` | per-OS data directory resolver |
| `build-exe.sh` | cross-compile the matrix from one machine (web build → embed → `bun build --compile`) |
| `entitlements.plist` | macOS JIT entitlements for codesigning |
| `THIRD-PARTY-NOTICES.txt`, `BUN-LICENSE.txt` | the Bun runtime's licence (MIT, with JavaScriptCore/WebKit under the LGPL 2.1) and where its source is; `build-exe.sh` copies both beside the binaries |
| `../../.github/workflows/desktop-release.yml` | CI: build matrix + attach to a tagged release |

## How it works
The launcher wraps the Bun server (`createServer` in `servers/bun/server.ts` — the server the Bun
conformance lane runs), so the desktop core is the *identical* gateway, schedules (including the
federation sync) and live rooms as the Node and Bun runtimes. At build time `gen-assets.ts`
embeds the built SPA + SQL migrations into the executable; the server applies migrations on first run,
sends every gateway route (`isGatewayPath` in the gateway's `app.ts`, the same split `deploy/Caddyfile`
makes) through `handle()` and serves everything else as the SPA (router-fallback to `index.html`), and
keeps SQLite in the OS app-data dir. `bun run
launcher.ts` in the repo gives a disk-backed dev run (no embed needed). RF is browser Web Serial/BLE
(operator-local); an always-on local feed is `apps/ingest`, run separately. The compiled binary is
self-contained: it serves the embedded SPA, gateway and migrations with no repository beside it.

## Build (one machine → all platforms)
```bash
bash deploy/desktop/build-exe.sh v1.0.0
# -> dist/desktop/aprscaching-{windows-x64.exe, macos-arm64, macos-x64, linux-x64, linux-arm64}
#    plus THIRD-PARTY-NOTICES.txt and BUN-LICENSE.txt
```

## Run & data location
Double-click or `./aprscaching-linux-x64`. SQLite lives in:
- Windows: `%APPDATA%\aprscaching`
- macOS: `~/Library/Application Support/aprscaching`
- Linux: `~/.local/share/aprscaching`

Back that directory up with `deploy/aprscaching backup`: it archives the database and the secrets
beside it ([Backups](../../docs/run/day-to-day/backups.md)).

## Network & secrets
The app listens on **`127.0.0.1` only**, so nothing else on your network can reach it. To serve your
LAN (a phone on the same Wi-Fi, an ingest box on a Pi), start it with `HOST=0.0.0.0` (or one LAN address);
`PORT` picks the port (`8787`).

On first run it generates three secrets and keeps them, owner-only, next to the database:

| File | Variable | Used by |
|---|---|---|
| `ingest.secret` | `INGEST_SECRET` | an ingest box feeding this app (`INGEST_URL=http://<this machine>:8787/ingest`) |
| `operator.secret` | `OPERATOR_SECRET` | `tools/admin/verify-call.mjs` and other operator scripts |
| `session.secret` | `SESSION_SECRET` | signing sign-in sessions (deleting it signs everyone out) |

Setting any of these variables in the environment overrides its file. Every other gateway setting
(`ADMIN_CALLSIGNS`, `FIRST_PARTY_SITES`, `INSTANCE`, rate limits, …) is read from the environment the same way
as on the Node and Bun servers. Back the secrets up with the database.

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
the Self-host shape in `deploy/`.
