# Tools — the sandboxed plugin/scripting system

**Project:** aprscaching.com · **Owner:** OE8APR
**Doc type:** Implementation doc for **Stage 2** (`docs/26`), sourced from `docs/27` Part B.3 (the
Graphic Packet extensibility heritage: parser-DLLs + GPRI `//PW` scripting, modernised).
**Status:** IMPLEMENTED (core + built-ins + web panel). Sandbox hardening + a registry are follow-ons.

---

## 1. What it is
A **capability-gated plugin system** that turns the workbench into a platform. A **Tool** extends the
terminal/BBS/workbench without touching core code, and can only reach the host surfaces it was granted.
Off by default, opt-in per Tool. A Tool can **never** bypass `verify.ts` trust or the TX gates.

## 2. Package (`packages/tools`, MIT, pure + tested — 12 tests)
- **`capabilities.ts`** — the permission set: `command · monitor · event · decoder · panel · map · beacon`
  and the **GATED** `network · tx · geo`. `tx`/`beacon` additionally pass a runtime TX gate.
- **`manifest.ts`** — dependency-free `tool.json` validation (`name, title, author callsign, version,
  permissions[], entry?, signature?`).
- **`host.ts`** — `ToolHost`: `register` · `setEnabled` (off by default) · `dispatch(event)` ·
  `runCommand` · `colourisers()` · `decoders()`. Each tool activates with a **capability-limited
  `ToolContext`** — every method throws if the capability wasn't granted; `scheduleBeacon`/`requestTx`
  also require the injected **`txGate()`** (the H5 / control-verification check) at call time.
- **`builtins/`** — the curated set: monitor **colouriser** (off `NAMES.GP`), **CTEXT macro pack**
  (`/cq /73 /qth`), **auto-responder** (greets `on_connect`), **beacon scheduler** (TX-gated), and the
  **F-5 PSK31 + CW decoders**.
- **`decoders/`** — pure **CW** (Morse timing→tokens→text) + **PSK31** varicode codec. The audio DSP
  front-ends (tone/BPSK demod → symbols) are browser-side Web Audio, **validate-at-deploy**.

## 3. Web (`apps/web/src/tools`)
- **`ToolsPanel`** (the "Tools" Workbench app — its own launched surface) — lists built-ins with a switch + their requested
  permissions, a **decode box** for the F-5 decoders, a **command runner**, and **import-by-URL** with a
  **permission-prompt dialog** before anything runs.
- **`sandbox.ts`** — imported (untrusted) tools run in a **locked-down Web Worker**: `fetch`, `XHR`,
  `WebSocket`, `importScripts` are shadowed unless `network` was granted + approved. v1 bridges
  **command-type** imported tools over `postMessage`; colouriser/decoder contributions stay
  built-in-only (they're hot per-frame functions that don't cross the Worker boundary cheaply).

## 4. Guardrails (the security posture)
- **Capability-gated:** a Tool sees only granted surfaces; ungranted access throws at activation.
- **TX is double-gated:** `tx`/`beacon` need the capability **and** a verified callsign (H5) at call time.
- **No trust bypass:** Tools have no path to `verify.ts` tiers or the corroboration engine.
- **Untrusted code is sandboxed:** imported scripts run in a Worker with network shadowed unless granted.
- **Off by default; explicit approval** for every imported Tool's permissions.

## 5. Runtime decision (recorded)
v1 uses a **locked-down JS Web Worker** for the third-party sandbox, not Lua/wasmoon — dependency-light,
unit-testable, tri-runtime-clean. The host API, capability model, built-ins and decoders are
**runtime-agnostic**, so a Lua runtime (wasmoon/Fengari) can be added later as a drop-in without
touching them.

## 5a. Surfaces (a tool's *type*) + the `panel` capability — IMPLEMENTED (2026-07)
Two additions make the plugin system serve **every** surface, not just the packet terminal:

- **Surfaces = the tool's type.** A manifest declares `surfaces: Surface[]` (`web` · `terminal` · `bbs`
  · `node` · `map`; defaults to `["web"]`). Capabilities say *what* a tool may do; surfaces say *where*
  its contributions appear. The host getters take a surface filter — `colourisers(s)`, `runCommand(w,a,s)`,
  `commandNames(s)`, `decoders(s)`, `panels(s)`, `dispatch(e,p,s)` — so each host asks only for the tools
  relevant to it. (`packages/tools/src/surfaces.ts`, `manifest.ts`, `host.ts`.)
- **`panel` capability = a real UI region, sandbox-safe.** A `panel` tool calls `ctx.setPanel(spec)` with a
  **declarative** `PanelSpec` (typed nodes: `text` · `kv` · `badge` · `bar` · `table`) — it never touches
  the DOM. The host renders it with semantic elements + theme tokens (`apps/web/src/tools/ToolPanels.tsx`);
  `sanitizePanel()` bounds the untrusted (imported) path. (`packages/tools/src/panel.ts`.)
- **One shared host.** `apps/web/src/tools/host.ts` is a module singleton (`useToolHost()` hook + a
  `CHANGED` event), so enabling a tool in the Tools app lights it up wherever its surfaces say — the
  packet terminal (monitor colourisers + a terminal panel region), BBS, the node, and the web console.
  This replaced the per-panel host that had siloed tools inside the Tools app.
- **Built-in surfaces:** monitor-colouriser=`terminal`; ctext-macros=`terminal,bbs`; auto-responder=
  `terminal,bbs,node`; beacon-scheduler=`terminal`; digimode-decoders=`web`; aprs-ssid-guide (`panel`)
  = `web,terminal,bbs` — demonstrates one plugin rendering on several typed surfaces.

## 5b. Graphic-Packet / LinPac patterns adopted (2026-07 — A–F)
Adopted from the GP/LinPac extension model (their macros, event bus, per-station DB, remote colon-
commands, shared vars, external "channel apps"):

- **A · Typed event context.** `ToolEventPayload` carries `{ surface, channel, peerCall, myCall, station,
  source, reply }` (LinPac's per-channel `_call`/`_state` vars + station DB). `on()` handlers and
  `dispatch()` are typed; the auto-responder now greets the *peer* by callsign. `on_frame` is
  **source-agnostic**: any feeder can dispatch a heard callsign with a `source` provenance label — the
  packet terminal feeds `"RF"` (TNC frames), the live APRS map layer feeds `"APRS"` — so mheard/watch-alert
  digest *all* heard traffic regardless of which surface is on screen (`apps/web` `feedHeard(call, source)`). (`host.ts`.)
- **B · `on_tick` timer event.** A periodic lifecycle event (the web host fires it every 60 s) for auto-
  status / watchdog / auto-ident tools — GP/LinPac timed macros. TX stays gated.
- **C · Macro variable expansion.** One shared `expand(text, vars)` (`macros.ts`) with the GP `{token}`
  set (`{call} {mycall} {peer} {chan} {grid} {date} {time}`); the packet terminal uses it. Unknown
  tokens are left intact.
- **D · Remote-invocable commands.** `manifest.remote: true` opts a command tool into being driven by a
  *connected remote peer* (GP colon-commands). `runCommand(w,a,surface,{remote})` gates it so a peer can
  never reach operator-only tools. No `remote` built-in ships (see §5d — we do not build an APRS PMS); the
  mechanism is there for third-party/imported tools. The Tools console has an "as a remote peer" toggle;
  the server-side consumer is the ingest/node session (`session-server`).
- **E · Shared var store.** `ctx.store` (LinPac `lp_set_var/get_var`) — a bounded per-host key/value scratch
  so cooperating tools share state (watch-alert/mheard keep their heard-lists in it).
- **F · "Channel apps" — concept adopted, raw exec rejected.** LinPac runs arbitrary Linux programs as
  channel-bound apps over stdio. In the browser we **never** exec; the sanctioned equivalents are the
  **Worker-sandboxed imported tool** (bound to a surface/channel via the event context) and the operator
  **companion/ingest box** (`docs/21`). The `channel` field in the event payload is what lets a tool act
  per-session like a GP app, without a shell.

## 5c. Built-in tools shipped (all OFF by default)
GP/LinPac-inspired built-ins mapped to our capabilities/surfaces (all client-side, capability-gated):

| Tool | Caps | Surfaces | GP/LinPac analog · function |
|---|---|---|---|
| monitor-colouriser | monitor | terminal | NAMES.GP — colour heard traffic by station type |
| ctext-macros | command | terminal,bbs | macros — `/cq /73 /qth` canned text |
| auto-responder | event | terminal,bbs,node | ctext.mac — greet a connect (now peer-personalised) |
| beacon-scheduler | command,beacon | terminal | timed beacon (TX-gated) |
| digimode-decoders | decoder | web | CW + PSK31 codecs |
| aprs-ssid-guide | panel | web,terminal,bbs | reference — conventional -SSID table |
| **watch-alert** | command,monitor,panel | terminal,web | **WATCH/CATCH** — highlight + log `/watch`-ed calls |
| **mheard** | monitor,event,panel | terminal,web | **MHEARD** — rolling recently-heard list, source-agnostic (RF + APRS + …) |
| **auto-status** | command,event,tx | terminal | timed macro — `/autostatus <min> <text>`, TX-gated |
| **grid-bearing** | command,panel | web,terminal | locator util — `/grid <A> [B]` distance + bearing |
| **sevenplus** | decoder | web | **7PLUS** — parse/reassemble multi-part 7plus messages |

## 5d. We do NOT build an APRS PMS (deliberate divergence)
Graphic Packet / LinPac ship a **PMS** (Personal Message System / personal mailbox) that a *connected*
peer drives with colon-commands. We considered a PMS mailbox tool and **dropped it on purpose** because
our messaging model diverges:

- **Our BBS is FBB store-and-forward over connected-mode AX.25 + signed federation** (`docs/25` P2–P3):
  threaded mail/bulletins, BIDs, hierarchical routing, one canonical store. That already *is* the mailbox
  — reimplementing a second, parallel mailbox as a plugin would fork the message store and the routing.
- **Classic APRS "PMS"/messaging is unconnected APRS *message* packets** (`:addressee:text{seq`, acked),
  a different transport with different semantics (unproto, per-message ACK, no threads). Bolting a
  connected-mode PMS plugin onto that would blur two message models users already keep distinct.
- So: the **`remote` capability + gate stay** (any third-party tool may still offer remote colon-commands
  on the node), but **no first-party PMS ships**. Connected-mode mail = the BBS app; APRS messaging =
  the Messages surface. They are intentionally separate and neither is a "tool".

## 5e. Deferred tools (documented, not built)
Evaluated from the GP/LinPac catalog; parked with the reason + what each needs:

- **Logbook** (event+store) — per-callsign connect/disconnect log (LinPac `LOGBOOK`/`cinit/cexit`).
  Needs persistence beyond the in-memory store (account data or export) → build once a tool storage/export
  surface exists.
- **RTT / ping** (command+tx) — round-trip time to a station (LinPac `RTT`). Needs the connected-mode
  round-trip timing hook on the ingest; TX-gated. Server-side consumer.
- **Auto-login / PW** (event+command) — auto-answer BBS/node auth (FBB MD2/MD5, FLEXNET, TheNet). Deferred
  on security grounds: it stores credentials, and per `docs/19` the APRS passcode verifies nothing. If
  built, do the **LoTW-TLS** path only, behind a security review.
- **File transfer (AUTOBIN / YAPP / 7plus-send)** — binary transfer protocols. Not a sandboxed plugin: it
  needs a new `transfer` capability **and** Web Serial framing — it belongs in the packet *terminal*, not
  the tool sandbox.
- **CONVERS / JOIN conference relay** — cross-channel bidirectional relay. Server-side (ingest/node)
  multi-session concern, not a browser plugin.

## 6. Follow-ons (not v1)
Signed-manifest verification + a community **registry/marketplace**; **imported** (Worker-sandboxed)
tools contributing colourisers/decoders/panels across the postMessage bridge (today only `/commands`
cross the worker boundary; built-ins get the full set); a `map` layer host surface (capability declared,
no host surface yet); the browser Web Audio DSP front-ends that feed the CW/PSK31 decoders live signal
(pairs `docs/16` H4).
