// SPDX-License-Identifier: MIT
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

/** One hop of a BPQ-style connect script: `C [port] <call>` (an optional radio port then a callsign). */
export interface ConnectStep { port?: number; call: string }

/**
 * Parse a BPQ connect script into hops. Each non-empty line is `C [port] <call>` (case-insensitive `C`);
 * a leading integer is the port, the last token is the callsign. Blank lines and non-`C` lines are ignored.
 * Example: "C NODE1\nC 3 DB0XYZ" → [{call:"NODE1"}, {port:3, call:"DB0XYZ"}]. Pure — the sequencer that
 * actually drives these connects (waiting for each node's prompt) is the radio leg (validate-at-deploy).
 */
export function parseConnectScript(script: string): ConnectStep[] {
  const steps: ConnectStep[] = [];
  for (const raw of script.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const toks = line.split(/\s+/);
    if (toks[0]!.toUpperCase() !== "C" || toks.length < 2) continue;
    const rest = toks.slice(1);
    const port = /^\d+$/.test(rest[0]!) && rest.length > 1 ? Number(rest.shift()) : undefined;
    steps.push({ ...(port != null ? { port } : {}), call: rest[rest.length - 1]!.toUpperCase() });
  }
  return steps;
}

/**
 * Drive a multi-hop connect script over an already-open link to the FIRST hop: for each subsequent hop
 * issue `C <call>`, wait for the node's "Connected to <call>" confirmation, then proceed; signal `onReady`
 * once the final hop is up, or `onFail` on a busy/failure/disconnect line. Pure + line-buffered — the ingest
 * feeds it the node's bytes and sends its command lines over the link; a scripted loopback drives it in tests.
 */
export interface SequencerHooks {
  send: (line: string) => void;         // transmit a command line to the current node (transport adds CR)
  onReady: () => void;                  // the final hop is connected — the forwarding session can start
  onFail: (reason: string) => void;
  connectedRe?: RegExp;                 // confirmation pattern (default /connected to/i)
  failRe?: RegExp;                      // failure pattern (default below)
}

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export class ConnectSequencer {
  private buf = "";
  private idx = 0;                      // steps[0] is already connected by the link; we drive steps[1..]
  private done = false;
  private readonly ok: RegExp;
  private readonly bad: RegExp;
  constructor(private steps: ConnectStep[], private h: SequencerHooks) {
    this.ok = h.connectedRe ?? /connected to/i;
    this.bad = h.failRe ?? /busy|failure|failed|no route|not? avail|invalid|reject|disconnect/i;
  }

  /** Begin sequencing (call once the link to the first hop is up). Direct (≤1 hop) → ready immediately. */
  start(): void {
    if (this.steps.length <= 1) { this.finish(); return; }
    this.idx = 1;
    this.h.send(`C ${this.steps[1]!.call}`);
  }

  /** Feed the current node's received bytes; advances on each confirmation, ready after the last hop. */
  feed(bytes: Uint8Array): void {
    if (this.done) return;
    this.buf += dec(bytes);
    let i: number;
    while (!this.done && (i = this.buf.search(/[\r\n]/)) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      if (this.bad.test(line)) { this.done = true; this.h.onFail(line); return; }
      if (this.ok.test(line)) {
        this.idx++;
        if (this.idx >= this.steps.length) this.finish();
        else this.h.send(`C ${this.steps[this.idx]!.call}`);
      }
    }
  }

  private finish(): void { if (!this.done) { this.done = true; this.h.onReady(); } }
}

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
