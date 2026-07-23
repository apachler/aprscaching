# Testing & verification tooling

Everything that verifies this repo, from unit tests to real-packet-software interop. All commands
run from the repo root after `pnpm install`.

## The three wrappers (day-to-day)

| Command | What it runs | Duration |
|---|---|---|
| `pnpm run check` | `pnpm -r build` (typecheck every package) + `pnpm -r test` (all unit suites) + the web typecheck & production build. No servers. | ~1–3 min |
| `pnpm run smoke` | Boots a throwaway Node/SQLite gateway (random port, temp DB, generated secret), runs the `smoke` + `geofence` conformance suites against it, tears down. | ~30–60 s |
| `pnpm run verify` | `check` then `smoke` — the full pre-commit gate. | ~2–4 min |

Also part of the gate: `pnpm lint` (fast ESLint), `pnpm lint:types` (type-aware rules over
`workers/` + `packages/`, its own CI job), `pnpm format:check` (Prettier).

## Unit tests (vitest)

~120 test files across `packages/aprs` (parser), `packages/ax25`, `packages/packet` (the largest
logic surface: NET/ROM, INP3, FBB incl. LZHUF), `packages/shared` (CBOR/fedwire),
`packages/tools` (DSP decoders, registry), `workers/gateway` (federation, auth, trust),
`servers/node`, and `apps/ingest` (transports, reconnect).

```bash
pnpm -r test                                    # everything
pnpm --filter @aprscaching/packet test              # one workspace
pnpm --filter @aprscaching/packet exec vitest run test/lzhuf.test.ts   # one file
```

Two workspaces intentionally have no vitest: `servers/bun` is covered by the Bun **conformance**
job (below), and `apps/web`'s gate is its typecheck + build plus the `no-emoji.mjs` guard.

## Conformance suites (runtime-agnostic)

`tools/smoke/*.mjs` are standalone scripts that hit a **running gateway** at `BASE` and assert the
full product behavior — the same suites run against all three runtimes, which is what makes the
tri-runtime promise real:

| Suite | Asserts |
|---|---|
| `tools/smoke/smoke.mjs` | The end-to-end gateway flow: ingest auth, caches, finds, trust tiers, BBS, federation signing (with `fedwire-mini.mjs`, an independent minimal CBOR codec used as a cross-implementation check) |
| `tools/smoke/geofence.mjs` | Real-time geofencing over WebSocket: a position near a cache produces a `near_cache` prompt for the right callsign only |
| `tools/smoke/federation.mjs` | Two instances: publisher seeds, subscriber pull-syncs, signature-verified mirroring (needs `PUB`, `SUB`, `RELAY_SECRET`) |

### Running them against each runtime

**Node + SQLite** — wrapped as `pnpm run smoke`. Manually:

```bash
KEY=$(node tools/fedkey/genkey.mjs --raw)
DB_PATH=/tmp/acs.db PORT=8787 INGEST_SECRET=devsecret ALLOW_DEV_TOKENS=1 \
  FIRST_PARTY_SITES=OE8XXX FED_PRIVATE_KEY="$KEY" \
  pnpm --filter @aprscaching/node-gateway start &
BASE=http://127.0.0.1:8787 INGEST_SECRET=devsecret node tools/smoke/smoke.mjs
BASE=http://127.0.0.1:8787 node tools/smoke/geofence.mjs
```

**Cloudflare Worker + D1** — migrate the local D1, write `.dev.vars`, start `wrangler dev`:

```bash
cd workers/gateway
CI=1 npx wrangler d1 migrations apply aprscaching --local
printf 'INGEST_SECRET=devsecret\nALLOW_DEV_TOKENS=1\nFIRST_PARTY_SITES=OE8XXX\nFED_PRIVATE_KEY=%s\n' \
  "$(node ../../tools/fedkey/genkey.mjs --raw)" > .dev.vars
CI=1 npx wrangler dev --port 8787 --local --ip 127.0.0.1 &
cd ../.. && BASE=http://127.0.0.1:8787 INGEST_SECRET=devsecret node tools/smoke/smoke.mjs
```

**Bun + bun:sqlite** — same env recipe as Node, started with `bun run servers/bun/server.ts`.

**Two-instance federation** — the CI job `conformance-federation` in `.github/workflows/ci.yml` is
the canonical recipe: keys from `tools/fedkey/genkey.mjs`, a signed registry from
`tools/fedkey/signregistry.mjs`, a publisher on `:8801` and a subscriber hub on `:8802`, then
`PUB=… SUB=… RELAY_SECRET=… node tools/smoke/federation.mjs`.

## Browser end-to-end

`pnpm run e2e:audio` (`tools/e2e/audio-mic.mjs`) exercises the **live microphone decode path** in a
real headless Chromium: it bundles the actual web-app decoder code, synthesises a PSK31 WAV of
"cq de test", feeds it in as a fake microphone, and asserts the decoded text. Skips cleanly (exit 0)
when no Chromium is available; CI installs one in the `e2e-audio` job.

`tools/webauthn/virtual-authenticator.mjs` is a **manual** check that drives a full passkey
register + login (and a tampered-signature rejection) against a running gateway via a Playwright
virtual authenticator. It is not wired into CI — the WebAuthn logic is unit-tested; this validates
the real browser ceremony before a release.

## Interop against real packet software

`tools/interop/` tests the FBB/NET-ROM stack against the actual programs it must talk to. Two
tiers (full detail in `tools/interop/README.md`):

- **Local loop, no Docker** — `bash tools/interop/run-local-loop.sh`: two complete aprscaching
  stacks crosslinked over AXUDP exchange NODES broadcasts both ways, run an FBB forwarding session
  A→B, verify BID idempotency, and (both nodes speak INP3) assert INP3 route convergence via
  triggered RIFs.
- **Containerized peers** — `tools/interop/docker-compose.yml` brings up **LinBPQ** (default),
  **F6FBB** (`--profile fbb`, needs host `modprobe ax25`), and **TheNetNode + JNOS**
  (`--profile extra`, source builds). Drivers in `tools/interop/tests/` assert NODES + forwarding
  into the BPQ BBS and that the real `xfbbd` answers with its FBB banner. The F6FBB container
  (`fbbcomp` on) is the live-validation peer for LZHUF-B1 compressed forwarding.

These run in the **nightly** `interop` workflow (scheduled + manual dispatch), never the PR loop —
peer downloads and kernel modules are not PR-gating dependencies.

## Key & signing tools used by tests

- `tools/fedkey/` — `genkey.mjs` (mint `FED_PRIVATE_KEY`), `rotatekey.mjs` (rotation + continuity
  proof), `signregistry.mjs` (signed instance registry). Used by every conformance job.
- `tools/toolkey/` — `genkey.mjs` + `sign.mjs` for tool-manifest/registry signatures
  (`packages/tools` verifies them).

## CI map (`.github/workflows/`)

| Workflow | Trigger | Gating? |
|---|---|---|
| `ci.yml` — lint · lint-types · unit tests + builds · conformance on Node, Worker, Bun · two-instance federation · audio e2e | push + PR | **Yes** |
| `interop.yml` — local loop · LinBPQ · F6FBB · TNN+JNOS | nightly + manual | Informational |
| `codeql.yml` | push/PR + weekly | Security scanning |
| `dco.yml` — every commit `Signed-off-by` | PR | **Yes** |
| `docs.yml` — `mkdocs build --strict` | docs changes | Yes (docs) |
| `desktop-release.yml` — Bun desktop binaries | tag `v*` | Release |
| `release-please.yml` — versioning + changelog | push (main) | Release |
