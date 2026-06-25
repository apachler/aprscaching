# Rule: RF ingest locality (operator-owned, never cloud-only)

**Scope.** `apps/ingest`, the browser RF bridge in `apps/web` (Web Serial / Web Bluetooth), the
gateway ingest endpoints (`workers/gateway`, `servers/node`), and all deployment tooling under
`deploy/`. Claude Code MUST honor this invariant whenever touching the ingest or the
ingest↔gateway boundary.

## Invariant (MUST)
- The **RF ingest MUST always be runnable on the operator's own equipment, in every deployment
  scenario.** It MUST NOT be cloud-only or coupled to any single host/topology.
- "Operator's equipment" means **either**:
  1. a **local process** — `apps/ingest` on a Pi / PC / mini-PC, **or**
  2. the **web browser** — the SPA bridging a USB/BLE radio via **Web Serial / Web Bluetooth**
     (USB KISS TNC, Mobilinkd, Meshtastic, etc.).
- A cloud VM MAY run an **APRS-IS-only** ingest for a baseline global feed, but that MUST NOT be the
  only way to get RF in.

## Implications
- `apps/ingest` MUST stay a **standalone, runnable component** whose `INGEST_URL` can target
  `localhost` (off-grid), a LAN gateway, or a remote cloud gateway — **gateway-location-agnostic**.
- The **browser RF path MUST be a first-class, supported ingest**: feature-detect Web Serial/Web
  Bluetooth, sign finds on-device (Ed25519 device key), and provide a non-RF fallback. It is
  **Chromium-only and session-bound** (no iOS/Safari) — so it complements, never replaces,
  `apps/ingest`.
- **Off-grid MUST work**: ingest + a local gateway on one box (`INGEST_URL=http://localhost:…`),
  no internet.
- The **over-APRS logging path** (RF find without a web session) MUST stay open via the ingest
  secret; never re-gate it.
- **Multi-operator → shared gateway**: use **per-operator peer keys** (Ed25519 / `callsign_keys`),
  not one shared `INGEST_SECRET` (shared secret is fine only for single-operator self-host).

## MUST NOT
- Make RF ingest require a specific cloud, a specific host, or an always-on server the operator
  can't run themselves.
- Remove or hide the browser RF path to force a server install.
- Bake a single cloud `INGEST_URL` as the only option in deployment tooling.

> Claude Code: wire this into `CLAUDE.md` by adding `@.claude/rules/ingest-locality.md` to the
> Rules section, alongside `ui-ux.md` and `css.md`.
