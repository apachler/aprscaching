# Dev toolset — deterministic build / test / conformance

Scripts that wrap the repetitive verification loop so every change is checked the same way, and the dev stack.
Run from anywhere (they `cd` to the repo root). Also wired as root pnpm scripts.

| Command | What it does | When |
|---|---|---|
| `pnpm run check` (`tools/dev/check.sh`) | `pnpm -r build` (typecheck every unit) + `pnpm -r test` (all vitest suites) + web typecheck & production build | fast inner loop after any code change |
| `pnpm run smoke` (`tools/dev/smoke.sh`) | spins a fresh Node/SQLite gateway on a throwaway DB + random port, waits for `/health`, runs each runtime-agnostic smoke suite on its own clean instance, tears down | prove the gateway's behaviour over a real database |
| `pnpm run verify` (`tools/dev/verify.sh`) | `check` then `smoke` — the full pre-commit / final gate | before committing / at the end of a change |
| `pnpm dev` (`tools/dev/dev.mjs`) | the gateway (from source, restarting on edits) and the Vite dev server on one origin, `.env.dev` written on the first run; `--ingest`, `dev:peer`, `dev:preview`, `dev:seed`, `dev:admin` | while working on the app |
| `pnpm dev:check` (`tools/dev/dev-stack-check.mjs`) | boots `pnpm dev` on free ports and proves sign-in, sessions, the live socket and a passkey through the one origin | after changing the dev tooling or the proxy |

Flags:
- `tools/dev/check.sh --build` or `--test` — only one half.
- `tools/dev/smoke.sh smoke` — a single suite; `SUITES="smoke geofence" tools/dev/smoke.sh`.

Notes:
- The **federation** smoke is a two-instance (PUB+SUB) e2e. `smoke.sh` runs the single-instance suites
  (`smoke`, `geofence`) by default; `tools/dev/smoke.sh federation` boots a publisher and a subscriber with
  the CI `conformance-federation` job's environment and runs it.
- Bun conformance runs the same `tools/smoke/*` suites under Bun in CI.
- These are dev conveniences; CI remains the source of truth.
