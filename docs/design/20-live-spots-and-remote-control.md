# Live activity spots & remote station control (reframed from POTACAT)

Status: **Backlog spec.** Two patterns adopted from POTACAT (Apache-2.0 spotting/CAT desktop app),
reframed for the APRScaching web platform: a **live activity-spots layer** on the map, and **remote
control of your own station** through the platform-as-cloud-relay. Clean-room — adopt the *ideas*,
reimplement; keep any GPL tools (Direwolf) as separate processes (we already do). Build against
`.claude/rules/{ui-ux,css}.md`, the cost rules, and `docs/design/16` (RF hardware) + `docs/design/19` (APRS-IS id).

> What we deliberately do NOT adopt from POTACAT (off-mission HF machinery): FT8/FT4/SSTV/FreeDV/CW
> decoders, FlexRadio panadapter / TCI spot-push, DXCC band-mode matrix, rotator control, contest rig
> profiles, in-app auto-update. They serve HF contesting/activating, not APRS-VHF caching.

---

## 1. Live activity-spots layer

Today our POTA/SOTA/WWFF data are **static** imported caches (`docs/design/11`/`docs/design/03`). POTACAT's core
idea is **live activity** — who is on the air *right now*, where. Add a real-time spots overlay that
makes the static heritage layer *living*.

- **Sources (read-only aggregation):** POTA, SOTA, WWBOTA, GMA spot APIs; DX-cluster; and the
  reception-report networks **RBN / PSKReporter** (and APRS-IS itself, which we already ingest).
- **Dedup + filter:** merge identical spots across sources (we already dedup imports); filter by
  band/mode/source toggles in a grouped, toggle-gated layer panel (ui-ux §2; **off by default** so
  the cacher's map stays clean — opt-in, like raster basemaps).
- **Map:** spots render as a distinct marker class alongside caches + APRS stations; clicking a spot
  shows station/activation detail and (if it coincides with a cache) links to that cache page.
- **Cache tie-in:** when a live spot coincides with a known cache (same park/summit ref or location),
  surface "**being activated now**" on the cache — a strong reason to go log it.
- **Trust tie-in (light):** RBN/PSKReporter are "who heard whom" reception networks — the same shape
  as our APRS-IS corroboration. Out of scope to feed the A/B/C tiers (different bands/modes), but the
  conceptual adjacency is worth noting for a future cross-network reception view.
- **Cost:** poll spot APIs server-side on a modest interval, cache at the edge, TTL aggressively
  (spots are ephemeral); never a per-client firehose. No persistence beyond a short-lived cache.

---

## 2. Remote station control (the ECHOCAT pattern, via our cloud-relay)

POTACAT's ECHOCAT operates a headless Pi station from a browser/phone, tunnelling through "POTACAT
Cloud" so there's no port-forwarding. **We already have both pieces:** the always-on **ingest box**
(`apps/ingest`, the headless station) and the **gateway as the cloud relay**. So a user can control
*their own* box from the web app with no port-forward.

- **Control surface (from the web app → gateway → the user's box):** trigger a beacon, send an APRS
  message, manage TX / IGate / digi state, view live RX, run a WX beacon (`docs/design/17`).
- **Transport:** the box holds an outbound authenticated connection to the gateway (it already POSTs
  ingest + reads the outbox); extend that to a command channel (the box long-polls / WS-subscribes a
  per-box command queue). No inbound ports on the box — the gateway is the rendezvous, exactly like
  POTACAT Cloud.
- **Gating (non-negotiable):** every TX-capable command is gated by **control-verification + explicit
  opt-in** (`docs/design/16` H5, `docs/design/19`); the box only executes commands signed for the callsign it's
  licensed to operate. RX-only boxes expose only read commands.
- **Headless parity:** mirrors POTACAT's headless mode — the box needs no GUI; the web app is the UI.
- **Federation note:** this is *operator→own-box* control, distinct from federation peer messaging
  (`docs/design/19` `aprsCall`). Don't conflate the command channel with the public APRS service identity.

---

## 3. Schema / API (small, additive)

```sql
-- watched callsigns (powers the alert in §4 of docs/design/11 / ADR-4b)
CREATE TABLE watch_calls ( account_id TEXT, callsign TEXT, added_at INTEGER, PRIMARY KEY (account_id, callsign) );
-- per-box command queue for remote control (RX-only boxes never get TX commands)
CREATE TABLE box_commands ( id INTEGER PRIMARY KEY AUTOINCREMENT, box_id TEXT, callsign TEXT, kind TEXT,
  payload TEXT, status TEXT NOT NULL DEFAULT 'queued', sig TEXT, created_at INTEGER );
```
API: `GET /api/spots?bbox=&bands=&modes=&sources=` (edge-cached); `POST /api/box/:id/command` +
`GET /api/box/:id/commands` (authenticated, signed, mirrors the outbox pattern); `GET/POST/DELETE
/api/watch` for watched callsigns. Spots are read-only and rate-limited like the public read API
(ADR-4a).

---

## 4. Rules / trust / cost
- ui-ux: spots + remote-control are **toggle-gated, collapsible** surfaces (the spots layer off by
  default, toggled in Search & filter → Live layers; remote control is a **Workbench app** — its own
  surface, launched from the workbench launcher — not the cacher map). One primary action each.
- css: markers/animation use `transform`/`opacity` only, reduced-motion paths; no blur over the map.
- trust: spots never touch the A/B/C find tiers; remote TX gated by control-verification, never by a
  passcode (`docs/design/19`).
- cost: spot polling is server-side + edge-cached + TTL'd; the command channel reuses the box's
  existing outbound connection (no new always-on infra, no inbound ports).

---

## 5. Milestones
- **S1 — spots aggregation (read):** server-side POTA/SOTA/WWBOTA/GMA poll + dedup + `GET /api/spots`;
  edge cache + TTL.
- **S2 — spots map layer:** opt-in, filterable overlay; spot detail; cache "being activated now" tie-in.
- **S3 — DX-cluster + RBN/PSKReporter sources:** broaden aggregation.
- **R1 — box command channel:** per-box signed command queue over the box's existing connection.
- **R2 — remote control UI:** a Workbench app (its own surface) — beacon / message / TX-IGate toggle / live RX; H5-gated.
- **W1 — watchlist alerts:** `watch_calls` + "watched callsign spotted/heard/near-a-cache" alert
  (extends `docs/design/11` / ADR-4b).

Small extensions tracked in their home docs: **Web Serial CAT one-click tune** → `docs/design/16` (new
H-phase); **day/night terminator + great-circle bearing arc + home-QTH marker** and **ADIF export** →
`docs/design/11`.

## 6. Acceptance (abbreviated)
- A live POTA/SOTA activation appears on the map (opt-in layer), deduped across sources; a coincident
  cache shows "being activated now."
- From the web app, a verified operator triggers a beacon on their own box with no port-forwarding;
  an unverified user / RX-only box cannot issue TX commands.
- A watched callsign becoming active raises an alert (permission-gated; in-app fallback).
- Spots never alter a find's trust tier.
