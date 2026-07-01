/**
 * netrom-connect-through.ts — NET/ROM connect-through (docs/29 F2): when a user connected to our node
 * types `C <dest>`, resolve the best route and bridge the inbound user link to an onward L4 circuit, so
 * data flows transparently user ↔ node ↔ destination. Pure: the outbound circuit is created by an injected
 * `CircuitDialer` (the ingest wires a real `NetromCircuit` over KISS to the neighbour; the loopback harness
 * bridges to a far circuit). This produces the `onConnect` handler a `SessionServer` node service uses.
 */
import type { NetromNode, LearnedRoute } from "./netrom-node.js";
import type { RelayController } from "./link-app.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The onward leg of a connect-through: send bytes to the destination, and tear it down. */
export interface OutboundCircuit { send(bytes: Uint8Array): void; disconnect(): void }
/** Open an onward circuit to `route`, delivering its data via `onData` and its teardown via `onClose`. */
export type CircuitDialer = (route: LearnedRoute, hooks: { onData: (b: Uint8Array) => void; onClose: () => void }) => OutboundCircuit;

/**
 * Build the node's `onConnect` handler. On `C <dest>`: no route → tell the user; otherwise dial the onward
 * circuit and splice it to the relay (user bytes → circuit, circuit data → user; circuit close → back to
 * the node prompt). Returns a handler for `SessionServer` `Service.onConnect` / `serveApp` `onConnect`.
 */
export function nodeConnectThrough(node: NetromNode, dial: CircuitDialer): (dest: string, relay: RelayController) => void {
  return (dest, relay) => {
    const route = node.best(dest);
    if (!route) { relay.toUser(enc(`Sorry, no route to ${dest}.\r`)); return; }
    relay.toUser(enc(`Connected to ${dest}.\r`));
    let closed = false;
    const out = dial(route, {
      onData: (b) => relay.toUser(b),
      onClose: () => { if (closed) return; closed = true; relay.detach(); relay.toUser(enc(`Disconnected from ${dest}. Back at node.\r`)); },
    });
    relay.attach((userBytes) => out.send(userBytes));     // transparent: subsequent user data → the onward circuit
  };
}
