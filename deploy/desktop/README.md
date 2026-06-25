# deploy/desktop — single-binary desktop app (Topology 0)

A self-contained executable (built with `bun build --compile`) bundling the **gateway + SPA +
optional local ingest**. Download one file, run it: it starts a local server, opens your browser,
and keeps SQLite in your OS app-data dir. RF comes from the **browser (Web Serial/BLE)** or the
bundled ingest — operator-local, per `.claude/rules/ingest-locality.md`. Works off-grid; it's a
federation peer like any other instance.

## Files
| File | Purpose |
|---|---|
| `launcher.ts` | entry point: start gateway → serve SPA → open browser → SQLite in app-data |
| `db-bun-sqlite.ts` | D1-compatible DB adapter over `bun:sqlite` (no native module) |
| `appdata.ts` | per-OS data directory resolver |
| `build-exe.sh` | cross-compile the matrix from one machine |
| `entitlements.plist` | macOS JIT entitlements for codesigning |
| `../../.github/workflows/desktop-release.yml` | CI: build matrix + attach to a tagged release |

## Wire-up (Claude Code)
In `launcher.ts`, connect the real repo exports (marked `TODO`): the runtime-neutral gateway handler
(as used by `servers/node`), the migration runner, the optional ingest starter, and the embedded
SPA import. Add a **`bun:sqlite` adapter** as a third DB backend behind your existing interface and
run the conformance suites under Bun too (same as Worker vs Node).

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
the other topologies in `docs/14-deployment.md`.
