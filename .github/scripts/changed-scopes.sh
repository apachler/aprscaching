#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# changed-scopes.sh — which ci.yml jobs a change can affect. It reads the changed paths, one per line, on stdin
# and prints one `job=true|false` line per job flag, the lines ci.yml's `changed paths` job writes to
# GITHUB_OUTPUT. `--all` prints every flag true without reading stdin (the diff could not be read).
#
# The scopes, and the jobs each one runs (`lint + format` always runs and is not listed):
#   all       ci.yml, this script, .github/actions/, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, a tsconfig,
#             an ESLint config: every Node job below
#   gateway   workers/, servers/, db/, tools/smoke/, tools/conformance/, tools/fedkey/, .bun-version
#   web       apps/web/ (its unit tests and their support files excepted: they change no build) and
#             workers/gateway/src/paths.ts, which the Vite config imports
#   ingest    apps/ingest/
#   packages  packages/: the gateway, the web app and the ingest import every one of them
#   audio     the code the audio and tool-sandbox e2e scripts bundle or serve: apps/web/src/rf/,
#             apps/web/src/tools/, apps/web/public/tools/, tools/e2e/audio-mic.mjs, tools/e2e/tool-sandbox.mjs,
#             tools/e2e/fixtures/
#   e2e       tools/e2e/
#   devtools  tools/dev/ (docs-theme.mjs excepted) and tools/webauthn/, which pnpm dev:check runs
#
#   code         (unit tests + builds)  anything but docs, Markdown, the Pocket scripts and repository metadata;
#                                       unit test coverage runs on the same flag
#   types        (lint, type-aware)     all, gateway, packages: it type-checks workers/gateway/src and packages/*/src
#   conformance  (the three legs)       all, gateway, packages
#   audio        (e2e-audio)            all, audio, packages, e2e
#   offline      (e2e-offline)          all, web, packages, e2e: it serves the built app with a stand-in gateway
#   devstack     (dev-stack)            all, web, gateway, packages, devtools
#   axe          (the axe shards)       all, web, packages
#   pocket       (Pocket scripts)       deploy/pocket/, deploy/lib/, ci.yml, this script
#   helpers      (Deploy helpers)       the deploy/ helper scripts and their tests, docs/reference/cli.md, ci.yml,
#                                       this script
set -euo pipefail

all=false code=false gateway=false web=false packages=false audio=false e2e=false devtools=false
pocket=false helpers=false

if [ "${1:-}" = "--all" ]; then
  all=true code=true pocket=true helpers=true
else
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      .github/workflows/ci.yml | .github/scripts/changed-scopes.sh | .github/actions/* | package.json \
        | pnpm-lock.yaml | pnpm-workspace.yaml | tsconfig*.json | */tsconfig*.json | eslint.config*.mjs)
        all=true ;;
    esac
    case "$f" in
      deploy/pocket/* | deploy/lib/* | .github/workflows/ci.yml | .github/scripts/changed-scopes.sh) pocket=true ;;
    esac
    # A case pattern's * also matches /, so deploy/*.sh alone would take in deploy/pocket/: the top-level scripts
    # are matched by their place instead.
    case "$f" in
      deploy/*/*) ;;
      deploy/*.sh) helpers=true ;;
    esac
    case "$f" in
      deploy/aprscaching | deploy/lib/* | deploy/test/* | deploy/desktop/*.sh | deploy/cloudflare/*.sh \
        | deploy/systemd/* | deploy/.env.example | deploy/oci/* | docs/reference/cli.md | .github/workflows/ci.yml \
        | .github/scripts/changed-scopes.sh)
        helpers=true ;;
    esac
    # Read by no Node job, so no scope below: the manual and Markdown (the docs workflow and the lint job check
    # them), the Pocket scripts (their own job), the other workflows and repository metadata, the editor and
    # formatter settings (the lint job checks formatting).
    case "$f" in
      docs/* | mkdocs.yml | overrides/* | *.md | .vale.ini | .vale/* | deploy/pocket/* | .claude/* \
        | .github/ISSUE_TEMPLATE/* | .github/DISCUSSION_TEMPLATE/* | .github/dependabot.yml | .github/workflows/*.yml \
        | CODEOWNERS | .editorconfig | .prettierrc.json | .prettierignore | .git-blame-ignore-revs)
        continue ;;
    esac
    code=true
    case "$f" in
      workers/* | servers/* | db/* | tools/smoke/* | tools/conformance/* | tools/fedkey/* | .bun-version) gateway=true ;;
    esac
    case "$f" in
      apps/web/test/visual/* | apps/web/test/fixtures/*) web=true ;;
      apps/web/test/* | apps/web/vitest.config.ts) ;;
      apps/web/* | workers/gateway/src/paths.ts) web=true ;;
    esac
    case "$f" in
      packages/*) packages=true ;;
    esac
    case "$f" in
      apps/web/src/rf/* | apps/web/src/tools/* | apps/web/public/tools/* | tools/e2e/audio-mic.mjs \
        | tools/e2e/tool-sandbox.mjs | tools/e2e/fixtures/*)
        audio=true ;;
    esac
    case "$f" in
      tools/e2e/*) e2e=true ;;
    esac
    case "$f" in
      tools/dev/docs-theme.mjs) ;;
      tools/dev/* | tools/webauthn/*) devtools=true ;;
    esac
  done
fi

any() {
  local v
  for v in "$@"; do [ "$v" = true ] && return 0; done
  return 1
}
flag() { if any "${@:2}"; then echo "$1=true"; else echo "$1=false"; fi; }

flag code "$all" "$code"
flag types "$all" "$gateway" "$packages"
flag conformance "$all" "$gateway" "$packages"
flag audio "$all" "$audio" "$packages" "$e2e"
flag offline "$all" "$web" "$packages" "$e2e"
flag devstack "$all" "$web" "$gateway" "$packages" "$devtools"
flag axe "$all" "$web" "$packages"
flag pocket "$pocket"
flag helpers "$helpers"
