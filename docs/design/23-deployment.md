# Deployment Topologies

> **Doc `23`** (the deployment runbook; `docs/design/14` is the accepted ADR set — don't confuse them). The
> canonical **reference instance is `aprscaching.net`** (docs/design/18; `.com` 301→`.net`); the
> `aprscaching.example.org` below is the **self-hoster placeholder** — substitute your own domain.
> RF-ingest locality is a loaded rule (`.claude/rules/ingest-locality.md`). Status: most `deploy/`
> scaffolding is **validate-at-deploy** (not yet exercised in CI), but **Topology 0 is built and
> validated** — `servers/bun/` runs the gateway on Bun + `bun:sqlite` (smoke + geofence conformance
> in CI), and `deploy/desktop/` compiles a working single-binary (`bun build --compile`, SPA +
> migrations embedded; the linux-x64 binary serves gateway + SPA + DB from an isolated dir).

aprscaching is **host-agnostic by design** — the tri-runtime build (`servers/node` on Node+SQLite,
`workers/gateway` on Cloudflare Worker+D1, and a **Bun single-binary** desktop via `bun:sqlite`) plus
federation mean you can run it **five ways**. This doc presents all five **as equals** with guidance +
a runbook each; pick by your needs, not a mandated default. Provisioning is the **simplest sensible
path per topology**.

## How to use this (Claude Code)
Pick a topology section, follow its runbook. The **Shared concerns** section applies to all five —
read it first. Every deployment MUST expose the AGPL §13 Source link (ADR-3) and back up its data.

---

## The runtime boundary (read this first)
- **Topology 0 uses the Bun runtime** (`bun:sqlite`) — a single self-contained binary that reuses the
  Node-runtime gateway code through a D1-compatible adapter (`deploy/desktop/db-bun-sqlite.ts`).
- **Topologies 1–3 use the Node + SQLite runtime** (`servers/node` gateway + `apps/ingest` +
  `apps/web` static). Same artifact, different placement/edge.
- **Topology 4 uses the managed Cloudflare runtime** (`workers/gateway` + D1 + R2 + Durable
  Objects). OCI holds **only** `apps/ingest` — the persistent APRS-IS socket Cloudflare can't host.
  Do **not** run SQLite and D1 at once; in #4 the DB is D1.

All four are **inter-migratable**: 1–3 share SQLite, #4 uses D1 (SQLite-compatible); `migrate.ts`,
dual-runtime conformance, and the federation `move` endpoint let data follow you between them.

## Core principle — RF ingest is ALWAYS on the operator's own equipment

**In every topology, the RF ingest runs on the operator's own equipment — never a cloud box.** That
bridge can take **two forms**, and both count as operator-local:

- a **local process** — `apps/ingest` on a Pi / PC / mini-PC, or
- the **web browser** — the SPA itself bridging a USB/BLE radio via **Web Serial / Web Bluetooth**
  (a USB KISS TNC, Mobilinkd, Meshtastic, etc.).

What's fixed is that the **radio and the bridge stay with the operator**. This is non-negotiable:

- **RF is physically at the operator.** KISS TNC (serial/TCP), soundcard AFSK, Meshtastic
  (serial/BLE), and GPS are at the QTH. A cloud VM can't reach them — only the operator's own
  machine can, via a local `apps/ingest` process **or the browser's Web Serial / Web Bluetooth**.
  RF-corroborated finds (Tier A) and off-grid operation exist *only* because the RF bridge is
  operator-side.
- **The over-APRS logging path lives here.** RF-originated finds attribute to a callsign (via the
  local ingest secret, or on-device signing in the browser) — never relocate or gate that off.
- **Each operator RF bridge is a network peer**, contributing RF coverage.

So separate the two placement questions — they are independent:

| Component | Where it runs |
|---|---|
| **RF ingest** | **ALWAYS the operator's own equipment** — a local `apps/ingest` process *or* the browser (Web Serial/BLE), in every topology |
| **Gateway / core / data / edge** | the variable — Pi, OCI, or Cloudflare (the four topologies below) |
| *(optional)* IS-only ingest | MAY run beside a cloud gateway for a baseline global APRS-IS feed — **not** a substitute for operator RF ingests |

**Two RF-bridge forms, same principle.** The **browser path** (Web Serial/BLE) is zero-install and
ideal for a cacher actively operating with their own TNC/Meshtastic — but it's **session-bound and
Chromium-only** (no iOS/Safari). The **local-process path** (`apps/ingest`) is always-on, headless,
and runs on any OS — for a persistent IGate/feed/peer or an off-grid base. Many operators use the
browser to log RF finds in the field and run `apps/ingest` for a 24/7 station.

The ingest is **gateway-location-agnostic**: it targets `localhost` (off-grid/local), a LAN gateway,
or a remote cloud gateway. The four topologies below choose where the **gateway/core** lives; the
**RF bridge stays with the operator** regardless.

## Choose by need

| # | Topology | Runtime | ~Cost/mo | Ops burden | Scale | Best for |
|---|---|---|---|---|---|---|
| 0 | **Single-binary desktop** | Bun+SQLite | $0 | **none** | single user | non-technical hams; download-and-run; off-grid |
| 1 | **Pi at home** | Node+SQLite | $0 (power) | low–med | small | makers/hams, a personal peer, learning |
| 2 | **OCI all-in-one VM** | Node+SQLite | $0 (OCI Always Free) | low | small–med | a self-hosted peer/club, no home-network hassle |
| 3 | **OCI core + Cloudflare CDN** | Node+SQLite | ~$0 | med | med–global | a public/flagship instance, global reach, resilient front |
| 4 | **OCI ingest + CF Workers/D1/R2** | CF managed | ~$0 idle | med–high | high | max managed scale, near-zero idle, fine with CF dependency |

---

## Shared concerns (apply to ALL topologies)

- **Env (Node runtime, 1–3):** `DB_PATH`, `PORT`, plus ingest: `APRSIS_HOST/PORT/CALLSIGN/PASSCODE/
  FILTER`, `INGEST_URL`, `INGEST_SECRET`, `BATCH_MS`. (CF runtime #4 uses `wrangler.toml` bindings +
  `wrangler secret`.)
- **Instance operator (sysop):** set **`ADMIN_CALLSIGNS`** (gateway) to the comma-separated licensed
  call(s) of the ham who deploys this instance, e.g. `ADMIN_CALLSIGNS=OE8APR` (`OE8APR,DL1ABC` for
  several). Only these calls — when **signed in** — may administer the instance (federation peers +
  trust, FBB forwarding partners/rules, NET/ROM node routes) via the in-app **Instance Admin** panel;
  every such write is gated server-side (`requireSysop`), not merely hidden. **Absent ⇒ no web sysop**
  (secure default: the config endpoints are locked; the operator-local ingest still uses
  `INGEST_SECRET`). Identity lives in env by design — who can administer the box is a deploy-time
  decision, not something a signed-in session can escalate. Server-side ingest/RF-box config is
  therefore operator-only; **web-only users get browser-direct RF (Web Serial / BLE / Web Audio) as their
  own field station** — no box required.
- **DB migrations:** Node → `migrate.ts` applies `db/migrations` to the SQLite file. CF → `wrangler
  d1 migrations apply`.
- **TLS:** self-host (1–2) use **Caddy** (automatic Let's Encrypt). Behind Cloudflare (3) TLS is
  terminated at the edge. CF Pages/Workers (4) is TLS by default.
- **AGPL §13 (ADR-3) — built:** every instance shows the in-app **Source** link (About & credits)
  pinned to its running commit and serves `/.well-known/source` + `/source` (302 → the repo tree at
  that commit). The commit auto-stamps from git when run from a clone; **self-hosters who modify the
  code MUST set `SOURCE_REPO` to their published fork** (`SOURCE_COMMIT` too if not deploying from
  git). `deploy-cf.sh` passes it as a Worker `--var`; Caddy/Cloudflare route `/source`.
- **Backups (mandatory):** SQLite is one file — snapshot it on a schedule to **OCI Object Storage**
  (20 GB free) or R2. For #4, schedule a **D1 export**. This is your only data SPOF on a free host.
- **Ingest secret:** the ingest→gateway POST is authed by `INGEST_SECRET`; the **over-APRS logging
  path depends on it** — set it, keep it secret, never disable that path.
- **Off-grid / local-only:** an operator can run the ingest **and** a local gateway on one box
  (`INGEST_URL=http://localhost:8080/ingest`) — full local map + RF with no internet. The off-grid
  ethos, preserved, in every topology.
- **Multi-operator → shared gateway (auth):** when several operators' local ingests feed one
  flagship gateway, give each a **per-operator peer key** (Ed25519 / `callsign_keys`) so it
  authenticates and attributes independently — not one shared `INGEST_SECRET` (a shared secret is
  fine only for a single-operator self-host).
- **Federation:** all topologies publish signed feeds; a peer elsewhere keeps the network alive if
  one instance vanishes. Run ≥1 peer for resilience.
- **Monitoring:** a simple uptime check on `/health`; OCI **budget alert** as a cost guardrail.
- **Cost rules still apply:** filter APRS-IS server-side, batch ingest, TTL the firehose, keep
  living-cache tracks, raster basemaps opt-in.

## Config model — 12-factor, with a runtime override tier (decision)

**Do we follow 12-factor config?** Yes (factor III). All deploy-time config is read from the *environment*
— Cloudflare Worker bindings + `wrangler secret` on runtime #4, `process.env` on the Node/Bun runtimes
(1–3, 0). There are **no per-environment config files checked into the repo**; the same build runs
everywhere and its behaviour is set entirely by env. Secrets (`INGEST_SECRET`, `FED_PRIVATE_KEY`) and
operator **identity** (`ADMIN_CALLSIGNS`) live only in env. ~119 distinct `env.*` reads, all optional with
safe defaults.

**Should env vars be overridable at runtime?** Partly — and we already do it where it's right. The model is
**two tiers**, and new config MUST be placed deliberately:

1. **Env (immutable, deploy-time) — secrets, identity, wiring.** `INGEST_SECRET`, `FED_PRIVATE_KEY`,
   `ADMIN_CALLSIGNS`, `INSTANCE`, DB/port/host bindings. These MUST stay env-only: making *who may
   administer the box* or *the signing key* mutable from a signed-in session would let a compromised
   account escalate. This is a security property, not a limitation — keep it.
2. **Runtime store (mutable, operator-editable) — operational policy + topology.** Already DB-backed and
   edited in the **Instance Admin** panel: forwarding partners (`bbs_partners`), routing rules
   (`bbs_forward_rules`), federation peers + trust (`fed_peers`), NET/ROM routes (`netrom_nodes`). These
   change with the network, not with a redeploy, so they belong in the DB, not env.

**Recommendation (post-1.0, non-blocking): add a thin `instance_config` KV table as an override layer for
NON-secret operational knobs** that today are env-only and would benefit from live tuning without a
redeploy — e.g. `min_trust` policy, `FED_CORROBORATION_QUORUM`, NODES broadcast interval, feature toggles.
Resolution order: **`instance_config` row → env default → hard-coded default** (a small `cfg(env, key)`
helper). Rules: sysop-gated writes; **never** shadow a secret or an identity key (those stay strictly env);
surface each override in Instance Admin with its effective source ("from env" vs "overridden"). This keeps
12-factor for bootstrap/secrets while giving the operator a redeploy-free control surface for policy — the
same pattern we already use for partners/peers, generalised. Not a v1.0 gate; flag for Stage 4/post-1.0.

### Common prereqs (1–3)
```bash
# Node 20 (ARM on Pi/OCI A1), pnpm, build
corepack enable && corepack prepare pnpm@latest --activate
git clone <your-repo> aprscaching && cd aprscaching
pnpm install
pnpm -r build
# NOTE (ARM): better-sqlite3 builds native; ensure build-essential/python3 present so it compiles.
```

---

## Topology 0 — single-binary desktop app (Bun)

**Architecture.** A single self-contained executable (built with `bun build --compile`) bundling the
gateway, the SPA, and an optional local ingest. Run it → it starts a local server on `localhost`,
opens the browser, and stores SQLite in the OS app-data dir. RF comes from the **browser
(Web Serial/BLE)** or the bundled ingest — operator-local, per `.claude/rules/ingest-locality.md`.
Off-grid out of the box; a federation peer like any other.

**Best for / tradeoffs.** The zero-dependency on-ramp for non-technical hams: download one file, run
it — no Node, no Docker, no terminal. Tradeoffs: one binary **per OS/arch** (cross-built from one
machine), ~50–100 MB each, and unsigned binaries trip Gatekeeper/SmartScreen (sign for a smooth UX).
Reuses the Node-runtime code via a **`bun:sqlite`** adapter — run conformance on Bun too.

**Build (one machine → all platforms).**
```bash
bash deploy/desktop/build-exe.sh v1.0.0
# -> dist/desktop/aprscaching-{windows-x64.exe, macos-arm64, macos-x64, linux-x64, linux-arm64}
```
CI: `.github/workflows/desktop-release.yml` builds the matrix and attaches binaries to a tagged
release. macOS signing/notarization needs a mac runner + Apple Developer ID; Windows wants an
Authenticode cert.

**Run & data.** Double-click (or `./aprscaching-linux-x64`). SQLite lives in `%APPDATA%\aprscaching`
(Win) · `~/Library/Application Support/aprscaching` (mac) · `~/.local/share/aprscaching` (Linux).
Back that file up (`deploy/backup.sh`). See `deploy/desktop/README.md` for wire-up + signing.

## Topology 1 — Pi at home (Node + SQLite, exposed via Cloudflare Tunnel)

**Architecture.** `servers/node` (gateway) + `apps/ingest` + SQLite + the built SPA, all on a Pi.
Simplest safe exposure for a home network (dynamic IP / CGNAT / no port-forwarding) is a free
**Cloudflare Tunnel** (`cloudflared`) — no public IP needed, TLS handled at the edge.

**Best for / tradeoffs.** $0 ongoing, maximal self-host spirit, great as a personal/club peer.
Downsides: home uptime, power, and bandwidth. Federation covers you if the Pi sleeps.

**Runbook.**
```bash
# 1) build (see common prereqs), then init DB
DB_PATH=/home/pi/aprscaching.db node servers/node/dist/migrate.js

# 2) run gateway + ingest as services (systemd units below)
sudo cp deploy/aprscaching-gateway.service deploy/aprscaching-ingest.service /etc/systemd/system/
sudo systemctl enable --now aprscaching-gateway aprscaching-ingest

# 3) expose via Cloudflare Tunnel (no port-forwarding)
cloudflared tunnel login
cloudflared tunnel create aprscaching
cloudflared tunnel route dns aprscaching aprscaching.example.org
# ingress: aprscaching.example.org -> http://localhost:8080 (incl. /ws upgrade)
cloudflared tunnel run aprscaching
```
*systemd (gateway):* `Environment=DB_PATH=/home/pi/aprscaching.db PORT=8080` ·
`ExecStart=/usr/bin/pnpm --filter @aprsweb/node-gateway start`. *ingest:* `Environment=APRSIS_FILTER=…
INGEST_URL=http://localhost:8080/ingest INGEST_SECRET=…` · `ExecStart=/usr/bin/pnpm --filter
@aprsweb/ingest start`.
*Backup:* nightly `sqlite3 aprscaching.db ".backup ..."` → push to R2/Object Storage.

> **The tunnel is the supported way to join federation from behind a firewall.** Federation is
> **pull-based** — to be a *contributing* peer (caches/finds mirrored onto others' maps, IGate hearings
> counting toward Tier-A corroboration quorum) a box must be **inbound-reachable at a URL**. A purely
> NAT'd/CGNAT box with no FQDN can pull and get *its own* finds to Tier A, but **can't be mirrored or
> answer corroboration**, so it's a read/verify-only leaf. The `cloudflared` step above fixes that with
> **no static IP, no FQDN-you-own, and no port-forward** — the tunnel's public hostname is what you put
> in peers' `fed_peers.url`, making the Pi a **full peer**. (Tailscale Funnel / ngrok are equivalents.)
> Reachability is pure transport: a tunnelled packet is no more or less trusted than a directly-served
> one — Tier is still set by `verify.ts` + quorum. A native, tunnel-free outbound-only join (push-to-hub
> for mirroring, rendezvous relay for corroboration) is specced as `docs/design/15` **T2.3** (F5).

---

## Topology 2 — OCI all-in-one VM (Node + SQLite + Caddy)

**Architecture.** One **Ampere A1 Flex** VM (2 OCPU/12 GB free) runs the gateway + SQLite and
serves the SPA; **Caddy** terminates TLS; a **reserved public IP** keeps the address stable. It MAY
also run an **APRS-IS-only** ingest for a baseline global feed — but **RF ingests run on operators'
local compute** (their radios), each pointing `INGEST_URL` at this VM. The datacenter VM cannot see
local RF hardware; that always stays at the QTH.

**Best for / tradeoffs.** Perpetual-free cloud, no home-network issues, solid self-host peer.
Caveats: OCI capacity/approval friction (use **Frankfurt** for AT); idle-reclaim does **not** bite
(the ingest socket keeps the box active).

**Runbook.**
```bash
# 1) Provision: OCI Console → Compute → Instance
#    Shape VM.Standard.A1.Flex (2 OCPU/12GB), Ubuntu 22.04 (ARM), Frankfurt.
#    Networking: reserved public IP; security list ingress 80,443.
# 2) On the VM: common prereqs + build, then:
DB_PATH=/opt/aprscaching/data.db node servers/node/dist/migrate.js
sudo systemctl enable --now aprscaching-gateway aprscaching-ingest   # same units as Topology 1

# 3) Caddy for TLS + static + reverse proxy (auto Let's Encrypt)
sudo apt install -y caddy
# /etc/caddy/Caddyfile:
#   aprscaching.example.org {
#     root * /opt/aprscaching/apps/web/dist
#     @api path /api/* /auth/* /ws* /ingest /outbox* /federation/* /.well-known/*
#     reverse_proxy @api localhost:8080
#     file_server
#   }
sudo systemctl reload caddy

# 4) DNS A record -> reserved IP. 5) OCI Budget alert. 6) Backup cron -> Object Storage.
```

---

## Topology 3 — OCI core + Cloudflare CDN (global edge in front)

**Architecture.** Topology 2's OCI box is the **origin**; **Cloudflare** sits in front (proxied
DNS) caching the static world (SPA, PMTiles, media) and bypassing dynamic paths. Adds global edge,
free TLS, HTTP/3, and DDoS protection. Optional variant: deploy the SPA to **Cloudflare Pages** and
point it at the OCI origin for `/api` + `/ws`.

**Best for / tradeoffs.** Public/flagship instance: ~$0, global performance, resilient front, while
the dynamic core stays on your own box. Slightly more moving parts than #2.

**Runbook.**
```bash
# Prereq: Topology 2 fully working on the OCI origin.
# 1) Add the domain to Cloudflare; set nameservers; create a PROXIED (orange) A record -> OCI IP.
# 2) Cache rules:
#    - Cache Everything for: /, /assets/*, *.pmtiles, /media/* (static)
#    - Bypass cache for: /api/*, /auth/*, /ws*, /ingest, /federation/*
# 3) Enable WebSockets (on by default on free plan) so /ws proxies through.
# 4) SSL/TLS mode "Full (strict)" with Caddy's cert on origin.
# (Optional) Deploy SPA to Pages instead of serving from origin:
wrangler pages deploy apps/web/dist   # then API/WS still hit the OCI origin via VITE_API_URL/VITE_WS_URL
```
*Keep media on the block volume (served by Caddy) or OCI Object Storage; CDN caches it either way.*

---

## Topology 4 — OCI ingest + Cloudflare Workers/D1/R2 (managed)

**Architecture.** The **managed Cloudflare runtime**: `workers/gateway` (API + Durable Object
fan-out) + **D1** (DB) + **R2** (media) + Pages (SPA). The `apps/ingest` component forwards batched
POSTs to the Worker `/ingest`: **RF ingests run on operators' local compute** (their radios), and
an always-on **APRS-IS-only** feed can run on any small box — a Pi, an OCI free VM, or similar.
Cloudflare can't hold the persistent APRS socket, and a datacenter box can't reach local RF — so
the ingest is never Cloudflare-side, and the RF ingest is always operator-local.

**Best for / tradeoffs.** Max managed scale, near-$0 idle (DO hibernation, free fan-out direction),
least server ops on the data plane. Tradeoff: Cloudflare dependency for the core; D1 limits apply.

**Runbook.**
```bash
# --- Cloudflare side (managed core) ---
cd workers/gateway
wrangler d1 create aprscaching                 # paste database_id into wrangler.toml
wrangler d1 migrations apply aprscaching
wrangler r2 bucket create aprscaching-media
wrangler secret put INGEST_SECRET
wrangler deploy                                # Worker + Durable Object
cd ../../ && wrangler pages deploy apps/web/dist

# --- OCI side (ingest ONLY) ---
# Smallest free box works: an A1 (shared with nothing) or even an AMD micro / a Pi.
sudo systemctl enable --now aprscaching-ingest
#   Environment: APRSIS_FILTER=…  INGEST_URL=https://gateway.<you>.workers.dev/ingest  INGEST_SECRET=…
```
*Backups here = scheduled **D1 export** (not a SQLite file). Media lives in R2.*

---

## Making each topology easy for the user

Layer three things so every scenario is roughly **one command, one click, or no install at all**:

**Cross-cutting enablers**
- **Browser RF = zero deploy.** For many operators there's *nothing* to deploy: open the site and
  connect a TNC/Meshtastic via Web Serial/BLE. The easiest path is no path.
- **Prebuilt multi-arch images** (amd64 + arm64) on a registry → no building from source, and the
  `better-sqlite3` ARM compile step disappears for Pi/OCI-ARM.
- **One Docker Compose file per self-host topology** → `docker compose up -d` brings up
  gateway + ingest + Caddy together. `.env.example` with sane defaults.
- **First-run setup wizard** (a `/setup` page or `aprscaching init` CLI): asks callsign, APRS-IS
  passcode, domain, and RF device; writes config; then **self-validates** (APRS-IS connect, TLS,
  the AGPL §13 Source link, backup target) with green checks.
- **Cloudflare Tunnel for home** → no port-forwarding, no static IP, no CGNAT pain.
- **One-click cloud** → an OCI **Resource Manager stack** ("Deploy to Oracle Cloud") whose
  cloud-init installs Compose and starts the stack; a single `wrangler`-driven script for the CF
  side.

**Easiest path per topology**

| # | Topology | Easiest path |
|---|---|---|
| 1 | **Pi at home** | flash image *or* `docker compose up -d` + `cloudflared` tunnel. (Or just use **browser RF** from any device on the LAN pointing at the Pi.) |
| 2 | **OCI all-in-one** | **"Deploy to Oracle Cloud"** Resource Manager stack → cloud-init runs Compose → enter callsign/domain → done. Manual fallback: create an A1 VM and paste the cloud-init. |
| 3 | **OCI + CDN** | do #2, then Cloudflare **"Add site"**; a small script applies the cache/bypass rules via the CF API (or follow the 4-line checklist). |
| 4 | **OCI ingest + CF Workers** | `pnpm deploy:cf` (one script: creates D1/R2/secrets, deploys Worker + Pages); operators run the ingest via Compose **or browser RF**. |

**The `deploy/` folder** (assets that make the above real): `Dockerfile` (multi-arch),
`docker-compose.yml` (+ per-topology overrides), `.env.example`, `Caddyfile`, `cloudflared` config,
`systemd` units, OCI **cloud-init** + a Resource Manager **stack** zip, a `deploy:cf` script, a
cache-rules script, the setup wizard, a backup script, and a per-topology README. Generating these
turns each runbook above into copy-paste — or one click.

## Migrating between topologies

- **1↔2↔3 (all SQLite):** copy the `.db` file (or restore a backup) to the new host, run
  `migrate.js`, re-point DNS. Trivial.
- **to/from #4 (SQLite↔D1):** both are SQLite-compatible; export rows and `wrangler d1` import, or
  use the account **`/api/account/:call/move`** + federation export/import to move records with
  signatures intact.
- **Resilience pattern:** run two topologies as **federated peers** (e.g. an OCI flagship + a home
  Pi) so neither is a single point of failure.

---

## Quick decision guide
- Want **zero cloud accounts / pure self-host**? → **1 (Pi)**.
- Want a **free, reliable peer** without home-network hassle? → **2 (OCI all-in-one)**.
- Running a **public/global instance** on a budget? → **3 (OCI + CDN)**.
- Want **managed scale + near-zero idle** and fine with Cloudflare? → **4 (OCI ingest + CF)**.
- Unsure? Start at **2**, add Cloudflare in front to become **3**, or move the core to **4** later —
  your data follows.
