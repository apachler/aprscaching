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
- [ ] Tri-runtime parity preserved (Node / Worker / Bun)
- [ ] AGPL §13 source link (`/.well-known/source`) still works
- [ ] No emoji in `apps/web`; styling follows `.claude/rules/css.md`
- [ ] SPDX header on new files; `packages/*` stayed MIT-clean

## Housekeeping

- [ ] Commits are **Conventional Commits** and **signed off** (`git commit -s`, DCO)
- [ ] Docs updated if behavior/config changed
