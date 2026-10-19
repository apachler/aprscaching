# Design harness — packet terminal & BBS (hardware-free)

A durable bench for iterating on the **packet terminal** and **BBS** UI shells without a TNC, a
gateway, or a sign-in. It mounts the **real** components (`PacketTerminal`, `BbsPanel`) wired to an
in-process simulator, so the surfaces render fully populated.

## Use

```
pnpm --filter @aprscaching/web dev
```

The benches load only in a development build or a driven browser (`navigator.webdriver`, as the visual and
accessibility harness runs it), through `demoAllowed()` in `allowed.ts`. A production page a person opens ignores
`?demo=` and loads the app: a bench signs the page in as a fixture account with a verified callsign and writes to
the visitor's own storage. The public tours (`/tour/game`, `/tour/shack`, `tourMode.ts`) are the isolated demo for
visitors.

Then open:

- `/?demo=packet` — the packet terminal, auto-connected to a loopback FBB BBS peer
- `/?demo=bbs` — the BBS panel with canned inbox / sent / bulletins
- `/?demo=1` (or `?demo=both`) — both, side by side
- `/?demo=app` — the whole app against canned gateway answers (`fixtures.ts`): caches of every type,
  stations, logs in all three tiers, messages, ranks. `&as=sysop` signs in as the instance's operator,
  `&as=out` shows the landing page. The visual and accessibility harness
  (`apps/web/test/visual/run.mjs`) renders the same page.

## How it works

- **`simPeer.ts`** — a `TermTransport` (the seam `PacketTerminal.makeTransport` accepts) whose far end
  is a **real `@aprscaching/ax25` `ConnectedLink`** acting as a BBS. The AX.25 SABM/UA handshake and
  I-frame exchange are genuine; only the serial hardware is replaced. Frames are delivered on a
  microtask (a real link is async), and a trickle of UI beacons feeds the monitor pane.
- **`simBbsApi.ts`** — a scoped `fetch` shim that serves canned `/api/bbs/*` JSON so the real
  `BbsPanel` populates with no gateway. Only `/api/bbs/*` is intercepted; everything else passes through.
- **`DemoHarness.tsx`** — mounts the surfaces; reached via the `?demo=` branch in `main.tsx`.

The `?demo=` code splits into its own chunk that a production page loads only under webdriver, and
`PacketTerminal` with no `makeTransport` uses real Web Serial behind its support gate.

## Why it exists

The protocol cores (`packages/ax25`, `packages/packet`) are testable without hardware; the **UI
shells** otherwise render only with a live TNC. This harness renders them without one, and is the bench
for UI work on the terminal shell, such as the Phosphor "flip" (a late-90s green-screen terminal look).
