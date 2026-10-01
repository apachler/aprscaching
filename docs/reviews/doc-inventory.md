# Documentation inventory — October 2026

!!! info "Review dated 1 October 2026"
    This is a point-in-time review record. It describes the documentation and code on `dev` at commit
    `ceab08b` and is not updated as either moves. It is the working list for the documentation sanity
    pass; the standing rule it applies is `.claude/rules/docs-and-comments.md`.

Every in-scope file was read in full and its concrete claims spot-checked against the code. Each file has
one primary audience and one type; mixed audiences are noted with the section that serves them.

**Audiences.** **U** new or casual ham · **P** experienced ham (power user) · **S** sysop / operator ·
**I** integrator / developer · **C** contributor / maintainer · **A** AI agent.
**Types.** tutorial · how-to · reference · explanation (design notes are explanation).

**Finding IDs.** `DOC-02-nn` present state · `DOC-03-nn` correctness · `DOC-04-nn` audience fit ·
`DOC-05-nn` structure and navigation · `DOC-06-nn` root documents, agent rules and `TODO.md`.

## Baseline

- `mkdocs build --strict` passes. It reports one broken anchor at INFO level (DOC-03-01) and the
  `reviews/` pages outside the nav, which `not_in_nav` now declares intentional.
- No relative link is broken in the manual, the root documents or the READMEs. External links are not yet
  checked (correctness pass).
- No milestone, phase, track, `SR-*` or `ADR-` code appears in the manual or the root documents, apart
  from the rule file's own examples and `TODO.md`'s P1–P3 priority scale (DOC-06-09).
- The configuration two-way diff for gateway, ingest, web and runtime keys is empty: 165 keys read by
  the code, all in `reference/configuration.md`, and no documented key unused. The deploy-script keys are
  the exception (DOC-03-11).

## Manual (`docs/`)

| File | Nav | Lines | Audience | Type | Purpose | Findings |
|---|---|---|---|---|---|---|
| `index.md` | Overview | 65 | U (I/C: "Architecture at a glance") | explanation | Front door: what it is, trust tiers, privacy, architecture | DOC-04-01, DOC-05-01, DOC-05-02, DOC-03-17 |
| `start-here.md` | Start here | 86 | U (S: "Run your own instance") | tutorial | Five-minute first find and the three paths onward | DOC-04-01, DOC-05-01, DOC-03-17 |
| `guides/account.md` | Guides | 159 | U (P: ampr.org, LoTW) | how-to | Sign-in, callsign verification, several calls, settings, your data | DOC-03-18, DOC-03-19, DOC-04-02 |
| `guides/caching.md` | Guides | 216 | U (P: MeshCom on the map) | how-to | Map, cache types, logging, radio logging, hiding, adoption | DOC-03-20, DOC-04-01, DOC-04-03, DOC-05-01 |
| `guides/my-radio.md` | Guides | 87 | P (S: secret forwarding) | how-to | Browser RF bridge: connect, forward, transmit, troubleshoot | DOC-04-01, DOC-05-05 |
| `guides/shack.md` | Guides | 95 | P (S: remote box; I: plugin authors) | how-to | The Shack app launcher and each app | DOC-04-04, DOC-05-05, DOC-05-06 |
| `guides/federation.md` | Guides | 233 | S/I (no U content) | reference | Joining, 44Net identity, peers, sync, registry, corroboration | DOC-04-05, DOC-05-03, DOC-05-07 |
| `concepts.md` | after Guides | 114 | S/I (U: opener) | explanation | Trust tiers, transport ≠ trust, identity, federation, runtimes | DOC-04-06, DOC-05-01, DOC-05-07, DOC-05-08 |
| `about.md` | last | 65 | U/P (C: licensing) | explanation | Privacy invariants, licensing, credits | DOC-03-21, DOC-05-02 |
| `operate/deployment.md` | Operating | 320 | S (I: D1 cost and write budget) | how-to | Choosing a deploy shape; secrets, backups, AGPL duties | DOC-02-01, DOC-03-22, DOC-05-09, DOC-05-10 |
| `operate/docker.md` | Operating | 136 | S | how-to | Docker stack: full, tunnel, ingest-only, off-grid | DOC-04-07, DOC-05-10 |
| `operate/44net.md` | Operating | 341 | S | how-to | Static 44.x address and a callsign-verified federation identity | DOC-05-11 (six **Unverified** markers go to the final report) |
| `operate/pocket.md` | Operating | 481 | S/P (C: tested-on, CI, SDR feasibility) | how-to | A whole station on an Android phone in Termux | DOC-03-23, DOC-04-08, DOC-05-10, DOC-05-12 |
| `operate/first-hour.md` | Operating | 118 | S | tutorial | Ordered path from boot to a public, verified, backed-up instance | DOC-04-09, DOC-05-10 |
| `operate/quickstarts.md` | Operating | 217 | U/P/S | how-to | Zero to packets on the map, per transport | DOC-04-10, DOC-05-04 |
| `operate/rf-ingest.md` | Operating | 142 | S/P | reference | The ingest box, transports, Tier A attestation, IGate, digipeater | DOC-05-04 |
| `operate/meshcom.md` | Operating | 165 | S/P | how-to | ExtUDP node setup, firewall, trust, radio-command answering | DOC-04-10, DOC-05-04 |
| `operate/packet.md` | Operating | 88 | P/S (C: AX.25 and INP3 internals) | explanation | AX.25, NET/ROM node, INP3, BBS, FBB forwarding | DOC-02-02, DOC-04-10, DOC-04-11 |
| `operate/rig-weather.md` | Operating | 43 | U/P | explanation | CAT rig control and weather (PWS, WX beacon, CWOP) | DOC-02-03, DOC-05-05 |
| `operate/rf-regulatory.md` | Operating | 113 | S/P | explanation | Amateur rules: what the platform enforces vs the operator | DOC-03-02 |
| `operate/administration.md` | Operating | 302 | S (P: remote box) | reference | Sysop identity, credentials, verification, imports, GDPR | DOC-03-03, DOC-05-13 |
| `getting-started.md` | Reference ("Run from source") | 93 | C/I | tutorial | Install and run every unit from a checkout | DOC-04-12, DOC-05-14 |
| `reference/api.md` | Reference | 201 | I (S: admin table) | reference | Every HTTP route with its gate | DOC-03-04, DOC-03-05, DOC-04-13 |
| `reference/federation-wire.md` | Reference | 328 | I (C: rationale) | reference | CBOR/Ed25519 frames, sync, corroboration, carriers | DOC-02-04, DOC-03-06, DOC-03-07, DOC-05-11 |
| `reference/federation-operations.md` | Reference | 25 | S | reference | Safe federation settings table | DOC-05-07 |
| `reference/configuration.md` | Reference | 192 | S/I | reference | Every environment variable | DOC-03-11, DOC-05-15 |
| `reference/cli.md` | Reference | 127 | S (C: development section) | reference | Scripts under `deploy/` and `tools/` | DOC-03-12, DOC-05-16 |
| `reference/licence-sources.md` | Reference | 73 | S/I | reference | Licence register sources, storage, normalisation | — |
| `reference/testing.md` | Reference | 134 | C | reference | Test, conformance and CI map | DOC-03-13, DOC-05-14, DOC-05-16 |
| `reference/specs.md` | Reference | 59 | C/I | reference | Open specifications each protocol is built from | — |
| `reference/meshcom-extudp.md` | Reference | 156 | I | reference | Firmware-verified MeshCom ExtUDP JSON protocol | — |
| `reference/data-model.md` | Reference | 54 | C/I | reference | Schema domains and identity tables | DOC-03-08, DOC-05-14 |
| `design/meshcom.md` | Design | 215 | C | explanation | MeshCom fit, trust, transmit, Via-Calls | DOC-02-05, DOC-03-01, DOC-03-09, DOC-03-10, DOC-05-17 |
| `design/radio-find-logging.md` | Design | 181 | C | explanation | Radio command engine (FOUND/DNF/NOTE/HELP/VERIFY) | DOC-02-06 |
| `design/meshcom-tdeck-map.md` | Design | 201 | C | explanation | T-Deck facts, map overlay concept, upstream issue drafts | DOC-02-07, DOC-05-18 |
| `reviews/federation-validation-2026-09.md` | not in nav (dated record) | 68 | C | review record | Federation validation findings, 28 September 2026 | DOC-02-08 |
| `reviews/doc-inventory.md` | not in nav (dated record) | — | C | review record | This inventory | — |
| `assets/shots/*.webp` (10) | — | — | — | images | Screenshots from `tools/teaser/run-docs.sh` | DOC-05-19 |

## Root documents, agent rules and READMEs

| File | Lines | Audience | Type | Purpose | Findings |
|---|---|---|---|---|---|
| `README.md` | 150 | U/I/C | explanation | Pitch, trust tiers, architecture, run-from-source, licence | DOC-05-02, DOC-06-01, DOC-06-02 |
| `INDEX.md` | 31 | A/C | reference | Repository map | DOC-06-03 |
| `CONTRIBUTING.md` | 141 | C | how-to | Setup, inner loop, commits, branches, DCO, licensing | DOC-06-04 |
| `SECURITY.md` | 101 | security reporters, S | reference | Private reporting, scope, hardening | DOC-02-09, DOC-06-05 |
| `SUPPORT.md` | 33 | U/S | how-to | Where to ask, what to include | — |
| `CODE_OF_CONDUCT.md` | 105 | everyone | reference | Contributor Covenant 2.1 | — |
| `CLAUDE.md` | 165 | A | reference | Agent conventions, invariants, commands | DOC-06-06 |
| `.claude/rules/ui-ux.md` | 217 | A/C | reference | UI/UX design principles | DOC-06-07 |
| `.claude/rules/css.md` | 189 | A/C | reference | CSS-over-JS rulebook | DOC-06-07, DOC-06-08 |
| `.claude/rules/ingest-locality.md` | 39 | A | reference | RF ingest always runs on operator equipment | DOC-06-10 |
| `.claude/rules/docs-and-comments.md` | 93 | A/C | reference | Present-tense docs and comments | DOC-06-09 |
| `TODO.md` | 812 | C/A | reference | Launch list and deferred backlog | DOC-02-10, DOC-06-11 |
| `deploy/README.md` | 72 | S | reference | Deploy shapes, file table, quick start, backups | — |
| `deploy/desktop/README.md` | 73 | S/P | how-to | Build and run the desktop binary | DOC-02-11 |
| `deploy/pocket/README.md` | 279 | S/P | reference | Pocket operator reference | DOC-02-11, DOC-03-14 |
| `tools/interop/README.md` | 92 | C | how-to | Interop test environment | DOC-02-12 |
| `tools/teaser/README.md` | 134 | C/A | how-to | Teaser, tour and docs screenshot tooling | DOC-02-12, DOC-03-15 |
| `tools/dev/README.md` | 20 | C/A | reference | Dev scripts (`check`, `smoke`, `verify`) | DOC-02-12, DOC-03-16 |
| `apps/web/src/demo/README.md` | 36 | C | how-to | Demo data harness | — |
| `servers/node/README.md` | 66 | S/C | reference | The Node + SQLite runtime | DOC-03-16 |
| `packages/*` | — | — | — | No package has a README | DOC-06-12 |

## Findings

### Present state (DOC-02)

| ID | Where | Finding |
|---|---|---|
| DOC-02-01 | `operate/deployment.md` "Upgrading an existing deployment" | One-time upgrade notes ("every user signs in once after the upgrade") are release history; they belong in `CHANGELOG.md` |
| DOC-02-02 | `operate/packet.md` | "on-air bring-up is a deploy step" hedges what runs; `apps/ingest/src/connected.ts` wires the stack over KISS/AXUDP |
| DOC-02-03 | `operate/rig-weather.md` | "Backend A" is a plan-slot label with no Backend B |
| DOC-02-04 | `reference/federation-wire.md` | "a bulletin under that older gid is still accepted" reads as history; restate as a compatibility rule |
| DOC-02-05 | `design/meshcom.md` | Status box calls transmit and find logging "design only" though both are built; "today", "later" framing; open question "once transmit exists" |
| DOC-02-06 | `design/radio-find-logging.md` | "Build order" and "Tests the implementation needs" narrate construction of a built feature; "Open points" holds settled behaviour |
| DOC-02-07 | `design/meshcom-tdeck-map.md` | "today's firmware", "open as of September 2026" — date external facts explicitly |
| DOC-02-08 | `reviews/federation-validation-2026-09.md` | Framed itself as a live tracker; now carries a dated-record header |
| DOC-02-09 | `SECURITY.md` | History note: "a full hardening pass was completed ahead of going public" |
| DOC-02-10 | `TODO.md` | Story wording (pre-launch pass "closed those", owner decision codes "(1c)/(2a)/(10a)", "instead of a boolean-per-panel…", "now runs", "gained ordered async command handling"); launch target "end of September 2026" has passed |
| DOC-02-11 | `deploy/desktop/README.md`, `deploy/pocket/README.md` | "Validated: …" journey note; "A `.env` from an earlier install lacks…" upgrade note |
| DOC-02-12 | `tools/interop/README.md`, `tools/teaser/README.md`, `tools/dev/README.md` | "caught two wire bugs on its first run… fixed"; "the original composed marketing hero"; "at the end of a slice" |

### Correctness (DOC-03)

| ID | Where | Finding | Code |
|---|---|---|---|
| DOC-03-01 | `design/meshcom.md` | Link to `#text-typemsg`; the anchor is `#text-type-msg` | `reference/meshcom-extudp.md` heading |
| DOC-03-02 | `operate/rf-regulatory.md` | Claims per-port configurable duty-cycle and rate limits and operator-set ID/beacon intervals; no such keys exist (rate limits are fixed internally; only `NETROM_BROADCAST_MS` exists). FlexNet/TheNet/BayCom are command personalities, not protocols | `apps/ingest/src`, `packages/packet/src/node-personalities.ts` |
| DOC-03-03 | `operate/administration.md` | Licence import "posts with `INGEST_SECRET`"; the tool requires `OPERATOR_SECRET` | `tools/licence/import.mjs:35` |
| DOC-03-04 | `reference/api.md` | Relay routes shown as `/federation/relay/:instance/…`; code has no `:instance`. Lease and answer are signature-gated (`x-relay-sig`), not `x-relay-secret` | `workers/gateway/src/relay.ts:110` |
| DOC-03-05 | `reference/api.md` | `GET /api/watch` and `POST /api/watch` undocumented | `workers/gateway/src/app.ts` |
| DOC-03-06 | `reference/federation-wire.md` | Names `/federation/feed/*`, which does not exist; the feeds are `/federation/caches`, `/finds`, `/bulletins`, `/keys`, `/tombstones`, `/account-moves`, `/registry` | `app.ts` |
| DOC-03-07 | `reference/federation-wire.md` | `bbs/enqueue` and relay `dispatch` said to accept the ingest box; both are sysop or `x-operator-secret` | `requireSysop({ allowOperatorSecret })` |
| DOC-03-08 | `reference/data-model.md` | "one SQL file, `0001_baseline.sql`"; migrations 0002–0006 add `fed_peers.caches_region`, corroboration retries, `cache_logs.corroborated_later_at`, `meshcom_nodes`/`meshcom_links`, `fed_peers.operator_call` | `db/migrations/` |
| DOC-03-09 | `design/meshcom.md` | "Stored positions carry no port" — `positions.transport` is stored and read by `transportOf()` | `workers/gateway/src/provenance.ts:94` |
| DOC-03-10 | `design/meshcom.md` | 150 "characters" (reference: bytes); groups "2–5 digit" (reference: 1–99999); a `{"type":"info"}` registration absent from the reference; dangling "see below" | `reference/meshcom-extudp.md` |
| DOC-03-11 | `reference/configuration.md` | Deploy-script keys absent: `BACKUP_BUCKET`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `DOMAIN`, `OCI_BUCKET`, `R2_ENDPOINT`, `TUNNEL_TOKEN`, `POCKET_*`; `BACKUP_RETENTION_DAYS` and `R2_ENDPOINT` documented nowhere | `deploy/.env.example`, `deploy/pocket/.env.pocket.example` |
| DOC-03-12 | `reference/cli.md` | `tools/checks/dead-exports.mjs` not listed | `tools/checks/` |
| DOC-03-13 | `reference/testing.md` | "~120 test files" (217); CI map omits `oci-stack.yml` and the MeshCom conformance step | `.github/workflows/` |
| DOC-03-14 | `deploy/pocket/README.md` | "weekly `pocket-termux` workflow"; it runs monthly | `.github/workflows/pocket-termux.yml:9` |
| DOC-03-15 | `tools/teaser/README.md` | Says to leave `PW_CHROMIUM` unset elsewhere, but `run-tour.sh` hard-codes `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; `SKIP_VIDEO`, viewport arguments and ten scripts undocumented | `tools/teaser/run-tour.sh:16` |
| DOC-03-16 | `tools/dev/README.md`, `servers/node/README.md` | Federation smoke "not by `smoke.sh`" (it runs on request); "CI runs both" runtimes (three); cron row omits the frequent federation sync | `tools/dev/smoke.sh`, `ci.yml` |
| DOC-03-17 | `index.md`, `start-here.md` | Link text "Getting started" and "Radio transports" differ from the nav labels "Run from source" and "RF ingest & transports" | `mkdocs.yml` |
| DOC-03-18 | `guides/account.md` | Settings table omits "Support the project"; says the Account group appears only after sign-in, but it renders signed out | `apps/web/src/identity/SettingsPanel.tsx:135,293` |
| DOC-03-19 | `guides/account.md` | "unlocks your place on the leaderboard" — to verify against the gateway | — |
| DOC-03-20 | `guides/caching.md` | "Profile → Logs sent over the air": the nav item is "You" | `apps/web/src/nav.ts:78` |
| DOC-03-21 | `about.md` | "Settings -> Data": the group is "Your data" | `SettingsPanel.tsx:271` |
| DOC-03-22 | `operate/deployment.md` | "You pick one of three shapes", then lists four (Pocket included) | — |
| DOC-03-23 | `operate/pocket.md` | Install one-liner pulls from `main`, README links point at `dev` | — |

### Audience fit (DOC-04)

| ID | Where | Finding |
|---|---|---|
| DOC-04-01 | U pages (`index`, `start-here`, `caching`, `my-radio`, `account`) | APRS-IS, IGate, TNC, KISS, AFSK, CAT, CI-V, SSID, q-construct, attested site, LoTW, NET/ROM used unexplained |
| DOC-04-02 | `guides/account.md` | DNSSEC/CNAME/resolver detail in a U how-to |
| DOC-04-03 | `guides/caching.md` | MeshCom section at P depth (RSSI/SNR, via lists); points U readers at the HTTP API |
| DOC-04-04 | `guides/shack.md` | Env keys (`BOX_ID`, `BOX_TX`) and capability enums in a user guide |
| DOC-04-05 | `guides/federation.md` | DB column names, a shell command, JSON bodies; no U content at all |
| DOC-04-06 | `concepts.md` | Linked as the tier definition for U readers but written for S/I (provenance object, env keys, test wording) |
| DOC-04-07 | `operate/docker.md` | No prerequisites block (clone, Docker/Compose version, DNS, ports 80/443, firewall) |
| DOC-04-08 | `operate/pocket.md` | `curl … \| bash` with no "review the script first" note |
| DOC-04-09 | `operate/first-hour.md` | Steps 6–8 lack a "how to check it worked"; no firewall note for a public box |
| DOC-04-10 | `operate/quickstarts.md` (digipeater), `operate/meshcom.md` (answering), `operate/packet.md` (node/BBS/FBB) | Transmit steps with no link to `operate/rf-regulatory.md` |
| DOC-04-11 | `operate/packet.md` | No how-to steps or success check; C internals mixed in |
| DOC-04-12 | `getting-started.md` | No step matching `INGEST_SECRET` between gateway and ingest; no gateway health check; `pnpm -r` and `pnpm run check` both offered |
| DOC-04-13 | `reference/api.md` | Several tables lack an Auth column; "Misc" is prose; shapes given for some routes only |

### Structure and navigation (DOC-05)

| ID | Where | Finding |
|---|---|---|
| DOC-05-01 | `index`, `start-here`, `concepts`, `caching` | Trust-tier table in four copies |
| DOC-05-02 | `index`, `about`, `README`, `concepts` | Privacy ("A map that forgets") and the AGPL source link repeated; README copies ~32 lines of `index.md` |
| DOC-05-03 | `guides/federation.md` | Sysop/integrator page under user Guides |
| DOC-05-04 | `rf-ingest`, `quickstarts` ×2, `meshcom`, `pocket` ×3, `administration` | Tier A / `RF_SITE_CALL` rule explained about eight times; `rf-ingest.md` is the natural canonical page |
| DOC-05-05 | `my-radio`, `shack`, `rig-weather` | Rig control split across three pages; `rig-weather.md` is user material under Operating |
| DOC-05-06 | `guides/shack.md` | Live stations and Spots are map features, not Shack apps (ui-ux §5); plugin reference belongs in Reference |
| DOC-05-07 | `guides/federation`, `reference/federation-operations`, `reference/configuration`, `concepts` | Federation settings and concepts spread over four pages |
| DOC-05-08 | `concepts.md` | Sits after Guides though Start here sends readers to it first |
| DOC-05-09 | `operate/deployment.md` | ~120 lines of D1 cost and write-budget reference inside a how-to; Desktop and Cloudflare-split walkthroughs live only in repo READMEs outside the manual |
| DOC-05-10 | `deployment`, `docker`, `pocket`, `first-hour`, `administration`, `rf-ingest`, `getting-started` | Backups, secrets and off-grid each explained three to four times |
| DOC-05-11 | `operate/44net.md`, `reference/federation-wire.md` | 44Net onboarding (S) inside the wire reference; HAMNET table in a how-to |
| DOC-05-12 | `operate/pocket.md` | 481 lines across install, extras, 44Net, federation, feasibility — split candidate |
| DOC-05-13 | `operate/administration.md` | Eleven topics; "Remote control of your box" is a per-user Shack feature; OpenCaching legal guidance deferred to `TODO.md` |
| DOC-05-14 | `getting-started`, `reference/testing`, `reference/data-model` | Contributor pages under Reference; `getting-started.md` filename differs from its title and is easily confused with `start-here.md` |
| DOC-05-15 | `reference/configuration.md` | Desktop variables listed twice; runtime knobs in prose |
| DOC-05-16 | `reference/cli.md`, `reference/testing.md` | Development commands duplicated |
| DOC-05-17 | `design/meshcom.md` | ExtUDP subsection duplicates the reference less accurately |
| DOC-05-18 | `design/meshcom-tdeck-map.md` | Upstream issue drafts and a shop ASIN are working material, not manual content |
| DOC-05-19 | `assets/shots/map-mobile.webp` | Not used by any page |

### Root documents, agent rules and `TODO.md` (DOC-06)

| ID | Where | Finding |
|---|---|---|
| DOC-06-01 | `README.md` | Calls `TODO.md` "the short post-1.0 deferred list" (812 lines, launch list included) |
| DOC-06-02 | `README.md` | Release badge and `releases/latest/download/aprscaching-oci-stack.zip` resolve only once a `v*` tag exists |
| DOC-06-03 | `INDEX.md` | `tools/` list omits interop, admin, fedkey, checks, conformance, e2e, licence, toolkey, webauthn; `deploy/` and `scripts/` absent; says README covers wrangler |
| DOC-06-04 | `CONTRIBUTING.md` | "pnpm 9+" (pinned `pnpm@11.9.0`); inner loop not centred on `pnpm run check`; omits `pnpm lint:types`, the federation smoke, `minimumReleaseAge` and one-lockfile-PR-at-a-time |
| DOC-06-05 | `SECURITY.md` | Scope glob `federation*.ts` misses `fed*.ts` (`fedapply.ts` `admitFrame()` and siblings); supported-versions table lists only 1.0.x while the version is 0.0.0 |
| DOC-06-06 | `CLAUDE.md` | "two guard scripts" (three: no-emoji, tour anchors, vendor-maplibre); Pocket missing from the deployment shapes; `TODO.md` described as post-1.0 only |
| DOC-06-07 | `ui-ux.md` vs `css.md` | `:target` / `details` disclosure: ui-ux forbids, css.md allows for simple disclosure; "shack" lower-cased against CLAUDE.md's single term "Shack" |
| DOC-06-08 | `css.md` | Stray closing `**` in five WON'T items; accent example is a teal value, the real token is green `oklch(0.73 0.18 128)` |
| DOC-06-09 | `docs-and-comments.md` vs `TODO.md` | Rule bans `P1`–`P4` as process codes; `TODO.md` uses P1–P3 as its priority scale |
| DOC-06-10 | `ingest-locality.md` | Trailing "wire this into `CLAUDE.md`" instruction is already done; scope omits `servers/bun`, Desktop and Pocket |
| DOC-06-11 | `TODO.md` | Done items stay as `[x]` (~33) with whole done sections, against its own "what shipped is in CHANGELOG"; `meshcom_msg` box command listed open though built (`workers/gateway/src/box.ts:193`); stale `Platform.tsx` path (now `platform/useMapInstance.ts`) |
| DOC-06-12 | `packages/*` | No READMEs for the MIT packages meant to be embeddable |

## Planned phases

| Phase | Branch | Covers |
|---|---|---|
| 1 | `claude/doc-1-inventory` | This inventory; dated header on the federation review; `reviews/` declared outside the nav |
| 2 | `claude/doc-2-present-state` | DOC-02 |
| 3 | `claude/doc-3-correctness` (split by section if large) | DOC-03 |
| 4 | `claude/doc-4-audience`, `claude/doc-4b-screenshots` | DOC-04, screenshots |
| 5 | `claude/doc-5-structure`, `claude/doc-5b-checks` | DOC-05, DOC-06, automated checks |
| 6 | `claude/doc-6-report` | Final report |
