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
  `terminal,bbs,node`; beacon-scheduler=`terminal`; digimode-decoders=`web`; **aprs-ssid-guide** (new,
  `panel`) = `web,terminal,bbs` — demonstrates one plugin rendering on several typed surfaces.

## 6. Follow-ons (not v1)
Signed-manifest verification + a community **registry/marketplace**; **imported** (Worker-sandboxed)
tools contributing colourisers/decoders/panels across the postMessage bridge (today only `/commands`
cross the worker boundary; built-ins get the full set); a `map` layer host surface (capability declared,
no host surface yet); the browser Web Audio DSP front-ends that feed the CW/PSK31 decoders live signal
(pairs `docs/16` H4).
