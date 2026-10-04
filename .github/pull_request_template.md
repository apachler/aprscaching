<!--
Thanks for contributing! Keep PRs small and focused. See CONTRIBUTING.md.
Title should be a Conventional Commit, e.g. "fix(ingest): reconnect only on close".
-->

## What & why

<!-- What does this change and why? Link any issue: "Closes #123". -->

## How it was verified

<!-- Commands you ran, and their result. -->

- [ ] `pnpm verify` is green (build + all unit tests + Node/SQLite smoke + geofence)
- [ ] Tests added/updated (a bug fix ships with the test that would have caught it)
- [ ] For federation/RF/trust changes: the relevant conformance suite passes

## Invariant checklist

- [ ] Trust model intact — transport ≠ trust; no bare IS packet reaches Tier B (`verify.ts`)
- [ ] RF ingest stays operator-runnable (not cloud-only)
- [ ] Runtime parity preserved (Node / Bun)
- [ ] AGPL §13 source link (`/.well-known/source`) still works
- [ ] No emoji in `apps/web`; styling follows `.claude/rules/css.md`
- [ ] SPDX header on new files; `packages/*` stayed MIT-clean

## Design checklist (for `apps/web` UI changes)

- [ ] Follows `.claude/rules/ui-ux.md` and `.claude/rules/css.md`: existing primitives (`Button`, `Segmented`,
      `Tabs`, `Icon`, …), tokens and role scales, no inline styles beyond custom properties
- [ ] Checked in Dark, Light and Phosphor, on a phone and a desktop width
- [ ] Every state the component has: hover, focus-visible, active, disabled, loading, empty, error
- [ ] Keyboard: reachable, visible focus, nothing hidden behind a sheet or the top bar
- [ ] Contrast test and axe green (`pnpm --filter @aprscaching/web test`; `run.mjs --only <surface> --strict`)
- [ ] Motion is `transform`/`opacity` only, with a reduced-motion path

## Housekeeping

- [ ] Commits are **Conventional Commits** and **signed off** (`git commit -s`, DCO)
- [ ] Docs updated if behavior/config changed
