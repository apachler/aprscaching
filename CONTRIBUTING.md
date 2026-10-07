# Contributing to APRScaching

Thanks for your interest — this is an amateur-radio-first, non-commercial, open project, and
contributions are welcome from hams, developers, and cachers alike. This guide gets you from clone to
green build to a mergeable pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules that never bend

A handful of invariants are load-bearing. A change that violates one will be sent back no matter how
good it otherwise is. They are documented in `CLAUDE.md` and `.claude/rules/`; the short version:

- **Trust follows corroboration, not transport.** Tier A/B/C semantics in
  `workers/gateway/src/verify.ts` are sacred: a bare APRS-IS packet can never reach Tier B, and
  Tier A needs an independently heard, first-party-attested RF fix — heard by the attested site's own
  receiver and delivered by its own ingest, never an APRS-IS copy. *Transport ≠ trust.*
- **RF ingest is always operator-runnable** — never cloud-only. See `.claude/rules/ingest-locality.md`.
- **AGPL §13 source link is launch-blocking.** Every instance exposes `/.well-known/source`; don't
  break it. If you run a *modified* public instance you must publish your source (set `SOURCE_REPO`).
- **Runtime parity.** Node+SQLite (`servers/node`) and Bun+`bun:sqlite` (`servers/bun`) both stay
  conformance-green. One shared handler set, the gateway app in `workers/gateway` (`@aprscaching/gateway`).
- **No emoji in the web UI** (`apps/web/test/no-emoji.mjs` enforces it) and **CSS-over-JavaScript**
  (`.claude/rules/css.md`). The shack aesthetic is ASCII/Phosphor on purpose.
- **Free in full, recognition-only.** No feature gating, no telemetry phoning home, nothing that
  smells commercial.

## Prerequisites

- **Node 22+** (CI uses 24) and **pnpm** at the version `package.json` pins (`corepack enable` gets you it).
- Optional: **Bun** (for the `servers/bun` runtime), a Chromium (for the audio e2e), and a KISS TNC /
  Web-Serial radio if you're working on RF ingest.

## Get set up

```sh
pnpm install
pnpm run check     # build every unit, run every unit suite (and the web guards), typecheck and build the web app
pnpm dev           # the instance on http://localhost:5173, reloading on every edit
```

[Run from source](docs/contribute/run-from-source.md) covers the operator sign-in, demo data, the ingest, a
federating peer and the production build.

## The inner loop

| Command | What it does |
|---|---|
| `pnpm run check` | fast gate: build + all unit tests + web typecheck and build, no servers |
| `pnpm run smoke` | runtime conformance: boots a Node/SQLite gateway, runs the smoke + geofence suites |
| `tools/dev/smoke.sh federation` | the two-instance federation e2e CI runs (a publisher and a subscriber) |
| `pnpm verify` | the full pre-PR gate: `check` then `smoke` |
| `pnpm --filter <package> exec vitest run test/foo.test.ts -t "name"` | one file or one test |
| `pnpm run coverage` | every unit suite under V8 coverage; the report lands in `coverage/` |
| `FUZZ_RUNS=100000 pnpm --filter <package> exec vitest run test/properties.test.ts` | a deep run of a parser's property tests |
| `pnpm dev` | run the instance: gateway and web app on `http://localhost:5173`, reloading on every edit |
| `pnpm dev:check` | prove the dev stack: sign-in, sessions, the live socket and a passkey through its one origin |

Run **`pnpm verify` before you open a PR**, and `tools/dev/smoke.sh federation` too for federation changes.
New functionality ships with automated tests: unit, conformance or e2e, as fits the change.
[Testing & verification](docs/contribute/testing.md) maps every suite and CI job.

## Linting & formatting

The repo uses **ESLint (flat config) + Prettier**. Formatting is enforced in CI.

```sh
pnpm lint          # eslint
pnpm lint:types    # type-aware eslint over workers/ and packages/ (slower; CI runs it)
pnpm format        # prettier --write (fix formatting)
pnpm format:check  # prettier --check (what CI runs)
```

CI also runs the guards under `tools/checks/`, among them `docs.mjs`, which holds the documentation to
[`.claude/rules/docs-and-comments.md`](.claude/rules/docs-and-comments.md) and to the configuration the code
reads.

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

### Operator notes

A change that makes an operator act before or after updating carries an `Operator-Action:` footer that says what
to do, in the present tense. Examples are a new required setting, a renamed or removed setting, a manual step such
as a re-import, or behaviour an operator must know about, such as a feature that is off by default:

```
feat(ingest): the NET/ROM node needs its own call

Operator-Action: set NETROM_CALL in the ingest box's .env to a call with a free SSID; the node stays off
without it.
```

The footer does not change the version: the commit type decides that, as above. When a release is published, the
release workflow collects every `Operator-Action:` footer since the previous release and puts them at the top of the
release notes under **Operator actions**; the update notice in Instance admin and `doctor` link those notes. The
pull request template has an **Operator action needed** section: end the PR description with the footer, since the
description becomes the squash commit's body. A footer forgotten at merge time can be added before the release by
putting the corrected commit message between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` lines in the merged
pull request's description.

## Branches and pull requests

1. Cut a feature branch from `dev`, named after its Conventional Commit type
   (`git switch -c feat/my-change origin/dev`; also `fix/`, `docs/`, `ci/`, `chore/`, …).
2. Open a pull request into `dev`. It is **squash-merged**, so the PR title and description become the
   commit on `dev`: write the title as a Conventional Commit (`feat(ingest): …`, `fix(web): …`).
3. Releases: a pull request from `dev` into `main`, merged (not squashed). release-please then opens the
   release PR on `main` (see [Releases](#releases)).
4. After a pull request merges, its feature branch is deleted (GitHub does this on merge); delete your
   local copy too, and start follow-up work on a fresh branch from `dev`.

Keep one concern per PR. If your change needs another PR that hasn't merged, wait for it, then rebase your
branch onto the updated `dev` rather than basing it on the other branch.

### Releases

`main` is the release branch and takes pull requests from three branches only: `dev`, a `hotfix/vX.Y.Z` branch,
and release-please's own release branch. The `head branch` check (`.github/workflows/main-pr.yml`) fails a pull
request into `main` from any other branch; it is optional, not one of the checks the `main` ruleset requires.

1. A pull request from `dev` into `main`, merged with a **merge commit**.
2. release-please opens or updates its release PR on `main`: the version and the `CHANGELOG.md` entry, from the
   Conventional Commits since the last release. Merging it tags `vX.Y.Z`, publishes the GitHub release and builds
   its downloads.
3. The release workflow then opens a pull request from `main` into `dev`, titled
   `chore(release): bring dev up to vX.Y.Z` (the `dev` ruleset takes changes by pull request only). It is merged
   with a **merge commit**, never a squash, so that `dev`'s history contains `main`'s.

**Two pull requests need a close and a reopen.** release-please's release PR (step 2) and the pull request into
`dev` (step 3) are opened with the workflow token, and GitHub starts no workflow for that token's events. Their
required checks (`lint + format`, `unit tests + builds`, the three conformance legs and the DCO `check`) therefore
never report, and the merge stays blocked. Close the pull request and reopen it: the reopen is yours, so CI and DCO
run. DCO skips a pull request opened by `github-actions[bot]`, and a skipped job counts as passed. Do it again
whenever release-please updates its PR. On the pull request into `dev`, never press *Update branch*: it would merge
`dev` into `main`.

### Hotfixes

A fix that cannot wait for the next release from `dev` ships as a patch release from the last release tag:

1. Cut the branch from the tag, named after the version it becomes:
   `git switch -c hotfix/v1.0.1 v1.0.0 && git push -u origin hotfix/v1.0.1`.
2. Land the fixes on it, as pull requests into `hotfix/v1.0.1` or as commits on it. Each one is a `fix:`
   Conventional Commit and signed off; a `feat:` makes the release a minor one.
3. Open a pull request from `hotfix/v1.0.1` into `main`, merged with a **merge commit**.
4. release-please reads the `fix:` commits the merge brings in and opens a release PR for `v1.0.1`. Merging it
   releases the patch.
5. The release workflow opens the pull request from `main` into `dev` (step 3 of [Releases](#releases)); close and
   reopen it, then merge it with a merge commit, which brings the fix to `dev`. The hotfix branch is deleted once it has merged.

### Dependencies

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 720`: a package version younger than 12 hours fails
  `pnpm install --frozen-lockfile`. A fresh Dependabot PR that fails only at install needs a re-run later.
- Merge dependency PRs that touch `pnpm-lock.yaml` one at a time, each rebased onto the current `dev` first.
  GitHub merges the lockfile as text and can produce duplicate keys (`ERR_PNPM_BROKEN_LOCKFILE`) even while
  it reports the PR as mergeable.

## Sign your work (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) — a one-line
attestation that you wrote the patch or have the right to submit it under the file's licence. Add it
by committing with `-s`:

```sh
git commit -s -m "fix(packet): guard the FBB session after FQ"
```

which appends `Signed-off-by: Your Name <you@example.com>`. The DCO check on your PR verifies every
commit carries it. (Set `git config user.name`/`user.email` to your real identity first.)

## Writing a Shack tool

A tool (a plugin for the Shack's **Tools** app) needs no change to this repository: it is a `tool.json` and a
script on any web server. The [tools site](https://apachler.github.io/aprscaching-tools/) covers writing one
([Write your first tool](https://apachler.github.io/aprscaching-tools/write/first-tool/), [the manifest](https://apachler.github.io/aprscaching-tools/write/manifest/),
[the sandbox API](https://apachler.github.io/aprscaching-tools/write/sandbox-api/)), publishing a registry ([Publish a registry](https://apachler.github.io/aprscaching-tools/publish/)) and listing a
tool in the project registry, which lives in `apachler/aprscaching-tools`
([Contribute a tool](https://apachler.github.io/aprscaching-tools/project/contribute/)).

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
- [ ] The invariants above still hold (trust model, ingest locality, runtime parity, source link).
- [ ] SPDX header on any new source file; `packages/*` stayed MIT-clean.

Small, focused PRs merge fastest. If you're planning something large, open an issue or discussion
first so we can agree the shape before you write it.

73 and thanks for building the open network with us.
