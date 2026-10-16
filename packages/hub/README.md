# @aprscaching/hub

The station hub's protocol cores: the pieces a server needs to share one station's radio ports with many packet
applications. It holds no socket, no timer and no radio driver, so the same cores run inside the APRScaching
ingest process and in a separate hub daemon. MIT-licensed, so other projects can embed it.

## What is in it

| Module | Exports |
|---|---|
| `framing.ts` | `KissClientStream` (one client's KISS stream: frames split across reads, SMACK and FlexNet CRCs removed, commands set aside and counted), `kissDataFrame()`, `frameAddresses()` (the address field of any AX.25 frame) |
| `arbiter.ts` | `TxArbiter`: a queue per radio port and client, served round-robin, with a per-client budget (frames and bytes per minute), a queue limit that drops the oldest, and a maximum wait; every drop counted by reason |
| `clients.ts` | `KissClients` (each client's view of the ports: all of them on their own numbers, or one port as port 0), `parsePortMap()`, `parseListeners()` |
| `kissserver.ts` | `KissServerCore`: the clients, their streams, the transmit policy (off by default; only listed base calls) and the arbiter, behind `connect` / `receive` / `heard` / `next` |

The KISS and AX.25 codecs come from `@aprscaching/aprs` and `@aprscaching/ax25`; this package adds no second copy.

## How a host uses it

```ts
import { KissServerCore, parsePortMap } from "@aprscaching/hub";

const core = new KissServerCore<Socket>({
  map: parsePortMap("", ["kiss-tnc", "soundcard-uhf"]),
  maxClients: 8,
  tx: true,
  txCalls: ["OE8APR"],
});
core.connect(sock); // a new client
core.heard("kiss-tnc", ax25); // a radio heard a frame: write each delivery to its client
core.receive(sock, chunk); // a client wrote: the ports that now have a frame waiting
core.next("kiss-tnc"); // when the host's pacing allows: the next frame, and the base call its gate judges
```

The ingest's host is `apps/ingest/src/hubserver.ts`: the TCP listeners, the box's token bucket and the hand-off
to each radio port's transmit gate. The manual's [Share the box's radio](https://docs.aprscaching.org/run/radios/kiss-server/)
covers the settings.

## Use it

The package is part of the repository's pnpm workspace and is not published to npm. Its entry is the TypeScript
source (`src/index.ts`), which Vite, Vitest, esbuild and Bun read as is. `pnpm --filter @aprscaching/hub test`
runs its tests.
