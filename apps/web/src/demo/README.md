# Design harness — packet terminal & BBS (hardware-free)

A durable bench for iterating on the **packet terminal** and **BBS** UI shells without a TNC, a
gateway, or a sign-in. It mounts the **real** components (`PacketTerminal`, `BbsPanel`) wired to an
in-process simulator, so the surfaces render fully populated.

## Use

```
pnpm --filter @aprsweb/web dev      # or: build + vite preview
```

Then open:

- `/?demo=packet` — the packet terminal, auto-connected to a loopback FBB BBS peer
- `/?demo=bbs` — the BBS panel with canned inbox / sent / bulletins
- `/?demo=1` (or `?demo=both`) — both, side by side

## How it works

- **`simPeer.ts`** — a `TermTransport` (the seam `PacketTerminal.makeTransport` accepts) whose far end
  is a **real `@aprsweb/ax25` `ConnectedLink`** acting as a BBS. The AX.25 SABM/UA handshake and
  I-frame exchange are genuine; only the serial hardware is replaced. Frames are delivered on a
  microtask (a real link is async), and a trickle of UI beacons feeds the monitor pane.
- **`simBbsApi.ts`** — a scoped `fetch` shim that serves canned `/api/bbs/*` JSON so the real
  `BbsPanel` populates with no gateway. Only `/api/bbs/*` is intercepted; everything else passes through.
- **`DemoHarness.tsx`** — mounts the surfaces; reached via the `?demo=` branch in `main.tsx`.

Nothing here ships in the production app path: the `?demo=` code-splits into its own chunk, and
`PacketTerminal` with no `makeTransport` behaves exactly as before (real Web Serial + its support gate).

## Why it exists

The protocol cores (`packages/ax25`, `packages/packet`) are testable without hardware, but the **UI
shells were not** — the terminal only rendered with a live TNC. This harness closes that gap and is the
bench the **Stage-3 Cogmind "flip"** (`docs/design/24` + `docs/design/25` P5) — the late-90s green-screen terminal
shell — will be built and reviewed on.
