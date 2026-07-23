# Contributing to aprscaching

Thanks for your interest — this is an amateur-radio-first, non-commercial, open project, and
contributions are welcome from hams, developers, and cachers alike. This guide gets you from clone to
green build to a mergeable pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules that never bend

A handful of invariants are load-bearing. A change that violates one will be sent back no matter how
good it otherwise is. They are documented in `CLAUDE.md` and `.claude/rules/`; the short version:

- **Trust follows corroboration, not transport.** Tier A/B/C semantics in
  `workers/gateway/src/verify.ts` are sacred: a bare APRS-IS packet can never reach Tier B, and
  Tier A needs an independently-gated, first-party-attested RF fix. *Transport ≠ trust.*
- **RF ingest is always operator-runnable** — never cloud-only. See `.claude/rules/ingest-locality.md`.
- **AGPL §13 source link is launch-blocking.** Every instance exposes `/.well-known/source`; don't
  break it. If you run a *modified* public instance you must publish your source (set `SOURCE_REPO`).
- **Tri-runtime parity.** Node+SQLite (`servers/node`), Cloudflare Worker+D1 (`workers/gateway`), and
  Bun+`bun:sqlite` (`servers/bun`) all stay conformance-green. One shared handler set (`@aprscaching/gateway`).
- **No emoji in the web UI** (`apps/web/test/no-emoji.mjs` enforces it) and **CSS-over-JavaScript**
  (`.claude/rules/css.md`). The shack aesthetic is ASCII/Phosphor on purpose.
- **Free in full, recognition-only.** No feature gating, no telemetry phoning home, nothing that
  smells commercial.

## Prerequisites

- **Node 22+** and **pnpm 9+** (`corepack enable` gets you pnpm).
- Optional: **Bun** (for the `servers/bun` runtime), a Chromium (for the audio e2e), and a KISS TNC /
  Web-Serial radio if you're working on RF ingest.

## Get set up

```sh
pnpm install
pnpm -r build      # typecheck + build every package (tsc --noEmit where applicable)
pnpm -r test       # every unit suite (includes the no-emoji guard)
```

## The inner loop

| Command | What it does |
|---|---|
| `pnpm -r test` | all unit suites |
| `pnpm -r build` | typecheck/build all units |
| `tools/dev/check.sh` | fast gate: build + all unit tests, no servers |
| `tools/dev/smoke.sh` | runtime conformance: boots a Node/SQLite gateway, runs the smoke + geofence suites |
| `pnpm verify` | the full pre-PR gate: `check.sh` then `smoke.sh` |
| `pnpm --filter @aprscaching/web dev` | run the web app |
| `pnpm --filter @aprscaching/gateway dev` | run the Cloudflare Worker gateway (needs a local D1) |

Run **`pnpm verify` before you open a PR.** For federation changes, the two-instance e2e
(`tools/smoke/federation.mjs`) is what CI runs — see `.github/workflows/ci.yml` for how it's wired.

## Linting & formatting

The repo uses **ESLint (flat config) + Prettier**. Formatting is enforced in CI.

```sh
pnpm lint          # eslint
pnpm format        # prettier --write (fix formatting)
pnpm format:check  # prettier --check (what CI runs)
```

Keep the rule set light — this is a low-friction project. If a rule is fighting legitimate code,
raise it in the PR rather than sprinkling `eslint-disable`.

## Commit messages: Conventional Commits

Releases are automated with **release-please**, which reads
[Conventional Commits](https://www.conventionalcommits.org/). Please format commit subjects as:

```
<type>(<optional scope>): <summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. A breaking
change uses `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer. Examples:

```
feat(verify): add plausible-track speed check for Tier A
fix(ingest): reconnect only on close to stop the login storm
docs: document the AGPL source-link obligation for self-hosters
```

`feat` → minor bump, `fix` → patch, breaking → major. `docs`/`chore`/`test`/`ci` don't cut a release.

## Sign your work (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) — a one-line
attestation that you wrote the patch or have the right to submit it under the file's licence. Add it
by committing with `-s`:

```sh
git commit -s -m "fix(packet): guard the FBB session after FQ"
```

which appends `Signed-off-by: Your Name <you@example.com>`. The DCO check on your PR verifies every
commit carries it. (Set `git config user.name`/`user.email` to your real identity first.)

## Licensing: inbound = outbound

The monorepo is licensed **by unit** (see `LICENSE` and each package's `LICENSE`):

- `apps/`, `workers/gateway`, `servers/`, `db/`, `tools/` → **AGPL-3.0-or-later**
- `packages/aprs`, `packages/ax25`, `packages/packet`, `packages/tools`, `packages/shared` → **MIT**
- `docs/` → **CC-BY-SA-4.0**

New code inherits the licence of the unit it lives in, and every source file carries an
`SPDX-License-Identifier` header — please keep that on new files. Keep `packages/*` MIT-clean (they're
embeddable): never add an AGPL-only dependency there. **Opening a PR licenses your change under the
same licence as the files it touches** (inbound = outbound).

## Pull request checklist

- [ ] `pnpm verify` is green locally.
- [ ] Tests added/updated for the change (a bug fix ships with the test that would have caught it).
- [ ] Commits are Conventional Commits and **signed off** (`-s`).
- [ ] No new emoji in `apps/web`; styling follows `.claude/rules/css.md`.
- [ ] The invariants above still hold (trust model, ingest locality, tri-runtime, source link).
- [ ] SPDX header on any new source file; `packages/*` stayed MIT-clean.

Small, focused PRs merge fastest. If you're planning something large, open an issue or discussion
first so we can agree the shape before you write it.

73 and thanks for building the open network with us.
