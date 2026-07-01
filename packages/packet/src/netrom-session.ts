/**
 * netrom-session.ts — the NET/ROM L4 inbound session server (docs/29 F2). The AX.25 `SessionServer` answers
 * connects that arrive as a raw AX.25 link; this answers connects that arrive as a NET/ROM *circuit*
 * terminating at us (a station reaching our node/BBS from across the network, multi-hop). `serveNetromApp`
 * binds a `LineApp` (the node CLI or BBS) to an accepting `NetromCircuit` via the shared `makeLineDriver`,
 * exactly as `serveApp` does for an AX.25 link — greeting on connect, line commands, connect-through relay.
 * Pure: the ingest wires the circuit's transport packets to KISS (framed to the reverse-path neighbour).
 */
import { NetromCircuit, type NrTpPacket, type CircuitState } from "./netrom-circuit.js";
import { makeLineDriver, type LineApp, type RelayController } from "./link-app.js";

/**
 * Stand up an accepting NET/ROM circuit bound to `app`. Feed the inbound ConnReq (and later packets) via
 * `circuit.onPacket`; the circuit sends its ConnAck + the app's replies through `opts.send`. Returns the
 * circuit — the caller registers it for demux and routes its outbound packets to the reverse-path neighbour.
 */
export function serveNetromApp(
  id: { index: number; id: number }, app: LineApp,
  opts: {
    send: (p: NrTpPacket) => void;
    onState?: (s: CircuitState) => void;
    onConnect?: (dest: string, relay: RelayController) => void;
  },
): NetromCircuit {
  // eslint-disable-next-line prefer-const -- the driver closes over `circuit` before it is assigned
  let circuit: NetromCircuit;
  const driver = makeLineDriver(app, { send: (b) => circuit.send(b), disconnect: () => circuit.disconnect(), onConnect: opts.onConnect });
  circuit = new NetromCircuit({
    send: (p) => opts.send(p),
    deliver: (info) => driver.onData(info),
    state: (s) => {
      if (s === "connected") driver.onUp();
      else if (s === "disconnected") driver.onDown();
      opts.onState?.(s);
    },
  }, id);
  return circuit;
}
