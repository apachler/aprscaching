# Tools — the sandboxed plugin/scripting system

**Project:** aprscaching.com · **Owner:** OE8APR
**Doc type:** Implementation doc for **Stage 2** (`docs/design/26`), sourced from `docs/design/27` Part B.3 (the
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
  never reach operator-only tools. Gating is **two-level**: the tool opts in with `manifest.remote`, and
  **each command** may further opt out with `registerCommand(word, fn, { remote: false })` — so a remote
  tool can expose read commands to peers (`/info`, `/whois`, `/note`) while keeping operator commands
  (`/setinfo`, `/away`) local-only. The Tools console has an "as a remote peer" toggle; the server-side
  consumer is the ingest/node session (`session-server`).
- **E · Shared var store.** `ctx.store` (LinPac `lp_set_var/get_var`) — a bounded per-host key/value scratch
  so cooperating tools share state (watch-alert/mheard keep their heard-lists in it).
- **F · "Channel apps" — concept adopted, raw exec rejected.** LinPac runs arbitrary Linux programs as
  channel-bound apps over stdio. In the browser we **never** exec; the sanctioned equivalents are the
  **Worker-sandboxed imported tool** (bound to a surface/channel via the event context) and the operator
  **companion/ingest box** (`docs/design/21`). The `channel` field in the event payload is what lets a tool act
  per-session like a GP app, without a shell.

## 5f. The platform is agnostic to tool function — the host routes, it never interprets
The single load-bearing invariant of the whole system, validated against Graphic Packet's own **GPRI**
(Remote Interface, `prog/gpri/`): GP the host offered a plugin exactly three services — `transmit(string)`,
`sendFile(name)`, `getQsoData()` — plus four lifecycle callbacks (`init` / `receive` / `strategy`-tick /
`exit`), and handed over QSO *context* a second way as env vars (`GP_CCALL`/`GP_MYCALL`/`GP_CPATH`/…). In
**every** case GP passed *who/where*, never *what the tool does with it* — it had no idea whether the remote
was ELIZA, a weather server, or a calendar.

Our host mirrors this exactly:

- **Every host-API method is a generic verb** — `registerCommand` / `on` / `addColouriser` / `addDecoder` /
  `setPanel` / `emit` / `subscribe` / `provideService` / `callService` / `store` / `scheduleBeacon` /
  `requestTx`. **None is named after a domain function.** There is no `getMheard()`, no `getWeather()`,
  no `renderGip()`. Our `ToolEventPayload` (`peerCall`/`myCall`/`channel`/`station`/`source`) *is* the
  direct analog of GP's `GP_*` context vars: context in, behaviour never.
- **All tool BEHAVIOUR lives in `builtins/` or imported (sandboxed) tools** — never in `host.ts`.
- **The rule, enforced by code review + the header comment in `host.ts`:** *never add a method named after
  a tool's function.* If a new feature seems to need one, it belongs in a tool that talks over the bus.

### Inter-tool IPC (the `ipc` capability)
Tools cooperate over a host-routed bus whose **payloads are opaque to the host** (it fans out / forwards
bytes; it never reads them). Two primitives, both gated by the `ipc` capability, both bounded (name ≤64
chars, re-entrancy depth ≤16 so a topic loop can't run away), both torn down when a tool is disabled:

- **Pub/sub** — `ctx.emit(topic, data)` → every `ctx.subscribe(topic, (data, from) => …)`. Example:
  `station-db` emits `station.seen {call,type}`; a panel or logger subscribes.
- **Named services (request/response)** — `ctx.provideService(name, fn)` / `ctx.callService(name, args)`.
  Example: `station-db` provides `station.type`; `info-responder`'s `/whois` calls it — the info tool
  resolves a callsign's classification **without knowing station-db exists**. This is GPRI's `getQsoData`
  generalised to plugin↔plugin. Services are host-global (cross-surface) by design — that is the point of a
  bus. The Tools console can introspect live topics/services via `host.ipcTopics()` / `host.ipcServices()`.

**Imported (Worker-sandboxed) tools** reach every surface with the SAME contribution set as built-ins, over
the `postMessage` bridge in `sandbox.ts`: the worker exposes `register({ commands, colourRules, panel,
decoders })` + an `ipc` object. Contributions split by whether they carry code:
- **Declarative → registered into the ToolHost** (reach terminal/BBS/node like a built-in): `colourRules`
  (compiled host-side into a sync monitor colouriser — no per-line Worker round-trip; `colorVar` is
  allow-listed to `--…`), and `panel` (an initial PanelSpec, plus live updates via `ipc.setPanel` →
  sanitised → re-rendered). ToolsPanel wraps the import as a host **adapter Tool** (carrying `entry`, so the
  built-in list filters it out — no duplicate row) and gates each contribution on the tool's grants.
- **Code-bearing → async worker round-trip**: `commands` (the existing path) and `decoders` (the Tools
  console `await`s `sandbox.decode(id, input)`).
- **IPC** (when granted `ipc`): `ipc.emit/subscribe/call` relayed to the bus via `hostEmit`/`hostSubscribe`/
  `hostCallService`.
So a sandboxed third-party tool cooperates over the same bus and contributes colourisers/decoders/panels
**without ever holding a host or another-tool reference** — the bridge is the only seam, subscriptions are
torn down on `destroy()`.

### Surface-provided services (GPRI generalised)
A **surface** (a trusted part of the app that owns a resource — the packet terminal owns the AX.25 link) may
also participate: `host.registerHostService(name, fn)` offers a capability *to* tools, and `host.hostEmit`
publishes to them. This is exactly GP's own model — GP the host exposed `transmit`/`getQsoData` to plugins —
and it's what powers the scripted-session engine (§5h). Still route-only; the host never interprets.

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
| **grid-bearing** | command,panel | web,terminal,bbs,node | locator util / **GP QTH** — `/grid <A> [B]` distance + bearing (remote-queryable) |
| **sevenplus** | decoder | web | **7PLUS** — parse/reassemble multi-part 7plus messages |
| **unit-convert** | command | web,terminal,bbs,node | **GP conv** — `/conv <n> <from> <to>` km/mi/m/ft/kn… + c/f (remote) |
| **cw-encoder** | command | web,terminal | **GP cw** — `/cw <text>` encode to Morse (send-side of F-5) |
| **station-db** | monitor,event,ipc | terminal,bbs,node | **NAMES.GP / autoname** — classifies heard stations, publishes on the IPC bus |
| **info-responder** | command,panel,ipc | terminal,bbs,node | **GP gpserv/gpdir** — peer `INFO / MENU / WHOIS` (WHOIS resolves via station-db over IPC) |
| **away-note** | command,event,panel | terminal,bbs,node | **GP msg** — away-message + let a peer leave a short note (*not* a mailbox — §5d) |
| **connect-bell** | event,panel | terminal,bbs,node | **GP bimmel** — rings/logs when a station connects |
| **link-ping** | command,ipc,panel | terminal,node | **GP rtt** — rolling round-trip time (samples over the `link.rtt` bus topic) |
| **sched-query** | command,event,ipc,panel | terminal,node | **GP GPAUTO** — `/gpauto <steps>` batch connect/waitfor/send/disconnect (drives the terminal's `session.script` service) |
| **block-art** | command,panel,ipc | web,terminal,bbs | **GP GIP** — render CP437/ANSI block art (`/art <text>`, or push `render.blocks` on the bus) |
| **map-waypoints** | command,map | web,map | `/wp <locator\|lat,lon> [label]` — drop markers on the map via the `map` surface |

## 5d. We do NOT build an APRS PMS (deliberate divergence)
Graphic Packet / LinPac ship a **PMS** (Personal Message System / personal mailbox) that a *connected*
peer drives with colon-commands. We considered a PMS mailbox tool and **dropped it on purpose** because
our messaging model diverges:

- **Our BBS is FBB store-and-forward over connected-mode AX.25 + signed federation** (`docs/design/25` P2–P3):
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
- **RTT / ping** — *now built* as `link-ping` (rolling stats + panel; samples arrive on the `link.rtt` bus
  topic). The remaining seam is the **terminal/ingest feeder** that actually times a round-trip probe and
  emits `link.rtt {ms}` — TX-gated, surface-side (not a tool concern).
- **Auto-login / PW** (event+command) — auto-answer BBS/node auth (FBB MD2/MD5, FLEXNET, TheNet). Deferred
  on security grounds: it stores credentials, and per `docs/design/19` the APRS passcode verifies nothing. If
  built, do the **LoTW-TLS** path only, behind a security review.
- **File transfer (AUTOBIN / YAPP / 7plus-send)** — binary transfer protocols. Not a sandboxed plugin: it
  needs a new `transfer` capability **and** Web Serial framing — it belongs in the packet *terminal*, not
  the tool sandbox.
- **CONVERS / JOIN conference relay** — cross-channel bidirectional relay. Server-side (ingest/node)
  multi-session concern, not a browser plugin.

## 5g. Graphic-Packet archive — remaining verdicts (2026-07)
From the full GP distribution (`gpri` spec + `remotes/` + `tools/`). Built ones are in §5c; the rest:

**Deferred (documented, not built):**
- **ELIZA auto-chat** (`gp_eliza`) — a remote chatbot responder. Trivial to build on `remote` + `event`;
  low priority, kept as a demo/teaser candidate.

**Rejected (with reason):**
- **Remote DOS shell** (`gp_shel2`) and **any exec-a-program tool** — we never exec (§5f/§5b F). A peer
  running host commands is exactly the boundary the sandbox forbids.
- **sysinfo** (`sysinfo`) — exposing host system/memory to peers is off-mission and leaky.
- **Password gate** (`pwd232`) — access control is a **platform** concern (`verify.ts` / control-verification),
  never a plugin. A tool must not be able to grant access.
- **QSO-SFX packer** (`qsosfx`) — a self-extracting archive helper; collides with the no-exec stance and has
  no clear browser analog.
- **TNC drivers / NET-ROM node** (`tfpcx`, `tfx`, `gp_node`) — already ours natively (GPLSL driver layer, P4
  node); not plugins.

## 5h. Scripted sessions (GPAUTO) — mechanism vs. policy split
GP's **GPAUTO** batched a `connect → waitfor → send → wait → disconnect` script against a BBS/cluster and
captured the reply (`.gpa` files). We keep that power while honouring §5f by splitting it in two:

- **Mechanism = the surface.** The packet terminal owns the AX.25 connection, so it holds a pure, tick-driven
  engine (`packages/tools` `ScriptRunner` + `parseScript`, testable, `Date.now()`-free) and exposes a single
  generic **`session.script`** host-service (`registerHostService`). Progress is published on the
  **`session.progress`** bus topic each poll. The terminal knows nothing about *why* — it just runs steps and
  drives its `TerminalSession`.
- **Policy = the tool.** `sched-query` parses the compact script (`connect HB9W-8; waitfor Cluster; send sh/dx;
  disconnect`), calls `session.script`, subscribes to `session.progress`, and renders the panel. `/gpauto every
  <min> …` re-runs it on `on_tick`. If no terminal is open the `callService` returns undefined and the tool
  says so — no coupling.

The step DSL (`connect`/`send`/`waitfor [timeout]`/`wait`/`disconnect`, `#`/`REM`/`***` comments) is a
**generic session-scripting primitive**, not a GPAUTO-specific feature baked into the platform — the same
service could drive any scripted connect flow. That is the invariant: the surface offers a capability, the
tool decides the script.

## 7. Signed manifests + the tool registry (marketplace)
Importing a tool by URL means running someone else's code (sandboxed, but still). Signing lets the user tell
*who* wrote it and that it wasn't tampered. Ed25519 over WebCrypto — same code in browser/Worker/Node/Bun
(`packages/tools/registry.ts`, MIT + dependency-free).

- **Manifest signature (integrity).** A `tool.json` MAY carry a raw author public key (`pubkey`, base64url)
  and a detached `signature` (base64) over the **canonical** manifest (`stableStringify`, every field except
  `signature`; `pubkey` is inside the signed bytes, so the key can't be swapped without breaking it).
  `checkManifestSignature` → `unsigned | valid | invalid`.
- **Identity via the registry.** A `registry.json` is an **authority-signed** list binding each tool
  `name`→`pubkey` (`{ entries, authority, sig }`; `sig` covers the canonical `entries`). The app pins ONE
  authority key (`apps/web/tools/registry-config.ts` — `TOOL_REGISTRY_AUTHORITY`, overridable via
  `VITE_TOOL_REGISTRY*`), so a forged / re-hosted / edited registry fails `verifyRegistry` and is dropped.
- **Trust resolution** (`resolveTrust`) combines the signature result + a registry match + a per-author
  **trust-on-first-use** pin (`localStorage acs.tool.keys`): `verified` (registry key matches) · `known`
  (matches your earlier pin) · `self-signed` (valid sig, new key — pinned on approve) · `unsigned`
  (URL-trust only) · **`invalid`** / **`key-changed`** → **hard-refused, never even prompted**.
- **UX.** The Tools console shows a signed **Registry** list (one-click *verified* import) + the manual
  URL import; the permission prompt carries the trust badge; approving a signed tool pins its key.
- **Authoring** (`tools/toolkey/`): `genkey.mjs` makes an Ed25519 key; `sign.mjs manifest tool.json` and
  `sign.mjs registry registry.json` sign with the **exact** canonicalisation `registry.ts` verifies. Private
  keys never enter the repo — only the signed artifacts + the pinned public authority constant. A worked
  example ships at `apps/web/public/tools/hello/` (a signed tool: command + colour rule + panel + ROT13
  decoder) listed in `public/tools/registry.json`.

Still open: a hosted community registry with multiple authorities + key rotation, and moving the pinned
authority to a `/.well-known` doc (pairs `docs/design/15` F7 governance).

## 6. Follow-ons (not v1)
The Tools platform is now feature-complete: imported-tool parity is **closed** (commands, IPC, colourisers,
panels, decoders all cross the worker boundary, §5f); signing + a registry gate third-party imports (§7);
the **`map` host surface** ships (a `map`-capability tool emits a declarative `MapLayerSpec` → `ToolMapLayers`
renders markers on the shared map; `map-waypoints` is the built-in producer); and the **audio front-ends**
ship — **CW** (`cwdsp.ts` Goertzel → `cwKeyEvents`) and **PSK31** (`psk31.ts` `psk31Demod`, differential
BPSK I/Q per symbol → varicode bits), both unit-tested end-to-end against a synthesised signal, driven by a
**Web Audio mic capture** (`apps/web` `audioDecode.ts` + a "Listen (mic)" button in the Tools decode box) —
so the F-5 CW/PSK31 decoders work on a live signal. The **weak/off-tuned refinement** now ships too:
`psk31DemodRobust` adds an **AGC** (unit-RMS), **carrier recovery by squaring** (x² doubles the phase so the
±180° data modulation vanishes, leaving a clean 2·carrier tone a fine DFT locks onto — immune to the reversal
sidebands that defeat a plain energy search over an idle preamble), and **symbol-timing recovery** (max-energy
sampling offset), then decodes differentially after de-rotating the residual carrier error θ (estimated from
`mean(z²)`). Unit-tested through a carrier offset + timing offset + additive noise (`psk31robust.test.ts`).

The **live mic path** is now streaming and tested end-to-end, not batch-and-validate-at-deploy:
- **Live/incremental.** `makeStreamDecoder` (`decoders/stream.ts`, pure) accumulates the mic chunks in a
  bounded window and re-runs the robust batch decoder at a throttled cadence, returning the full text so far —
  so text appears *as you listen* (surfaced via `onText` under the "Listen (mic)" button). Unit-tested by
  feeding synthesised PCM in 128-sample frames (`stream.test.ts`).
- **Off-main-thread tap.** `audioDecode.ts` taps PCM with an **AudioWorklet** (keeps sample handling off the
  map render loop per `.claude/rules/css.md`), falling back to `ScriptProcessorNode` where worklets are absent.
- **Headless E2E.** `tools/e2e/audio-mic.mjs` bundles the *real* `audioDecode.ts` and drives it in Chromium
  fed by a synthesised, +6 Hz off-tuned PSK31 signal through the browser's **fake-audio-capture** device,
  asserting the decoded text — exercising getUserMedia → AudioContext → AudioWorklet → StreamDecoder for real.
  It runs as the `e2e-audio` CI job (`pnpm e2e:audio`) and self-skips where no browser is available.

**Remaining (validate-at-deploy):** only real-radio behaviour on live off-air signals (true noise, QSB, drift,
adjacent-signal interference) — inherently a field test, not something a synthesiser or CI can stand in for.
