# Dev toolset — deterministic build / test / conformance

Three scripts that wrap the repetitive verification loop so every change is checked the same way.
Run from anywhere (they `cd` to the repo root). Also wired as root pnpm scripts.

| Command | What it does | When |
|---|---|---|
| `pnpm run check` (`tools/dev/check.sh`) | `pnpm -r build` (typecheck every unit) + `pnpm -r test` (all vitest suites) + web typecheck & production build | fast inner loop after any code change |
| `pnpm run smoke` (`tools/dev/smoke.sh`) | spins a fresh Node/SQLite gateway on a throwaway DB + random port, waits for `/health`, runs each runtime-agnostic smoke suite on its own clean instance, tears down | prove the Worker-equivalent behaviour over a real DB |
| `pnpm run verify` (`tools/dev/verify.sh`) | `check` then `smoke` — the full pre-commit / final gate | before committing / at the end of a slice |

Flags:
- `tools/dev/check.sh --build` or `--test` — only one half.
- `tools/dev/smoke.sh smoke` — a single suite; `SUITES="smoke geofence" tools/dev/smoke.sh`.

Notes:
- The **federation** smoke is a two-instance (PUB+SUB) e2e and is exercised in CI separately, not by
  `smoke.sh` (which covers the single-instance suites: `smoke`, `geofence`).
- Bun conformance runs the same `tools/smoke/*` suites under Bun in CI.
- These are dev conveniences; CI remains the source of truth.
