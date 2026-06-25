#!/usr/bin/env bash
set -euo pipefail
# Cross-compile the desktop single-binary for ALL platforms from ONE machine. Requires Bun + pnpm.
# Usage: bash deploy/desktop/build-exe.sh [version]
cd "$(dirname "$0")/../.."                                  # repo root
VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo dev)}"
OUT="dist/desktop"; mkdir -p "$OUT"

echo ">> building SPA (apps/web) — same-origin API + offline basemap for the desktop binary"
VITE_API_BASE="" VITE_BASEMAP=offline pnpm --filter @aprsweb/web build   # -> apps/web/dist

echo ">> embedding SPA + migrations"
bun run deploy/desktop/gen-assets.ts                       # -> deploy/desktop/assets.generated.ts

ENTRY="deploy/desktop/launcher.ts"
build() { echo ">> $2"; bun build --compile --target="$1" \
  --define "BUILD_VERSION=\"$VERSION\"" "$ENTRY" --outfile "$OUT/$2"; }

build bun-windows-x64  "aprscaching-windows-x64.exe"
build bun-darwin-arm64 "aprscaching-macos-arm64"
build bun-darwin-x64   "aprscaching-macos-x64"
build bun-linux-x64    "aprscaching-linux-x64"
build bun-linux-arm64  "aprscaching-linux-arm64"

echo ">> done -> $OUT"
echo "   macOS sign:  codesign --deep --force -s 'Developer ID Application: <YOU>' \\"
echo "                  --options runtime --entitlements deploy/desktop/entitlements.plist \\"
echo "                  $OUT/aprscaching-macos-arm64   (then notarize with notarytool)"
