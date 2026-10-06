// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * terminalTools.ts — what the packet terminal offers the tools while its TNC is open: `on_connect` and
 * `on_disconnect` for every connected channel, a reply and remote commands on channels other stations opened
 * (SessionEvents), round-trip samples on `link.rtt`, and the answer to `link.ping.request`. Every line a tool sends
 * goes through the terminal's own session and its transmit gate, and shows in Recent transmissions under the tool's
 * title. Free of React, so the tests drive it with a real TerminalSession over a loopback.
 */
import type { Ax25Frame } from "@aprscaching/ax25";
import type { TerminalSession } from "@aprscaching/packet";
import { SessionEvents, type SessionEventsOpts, type ToolHost } from "@aprscaching/tools";
import type { TxFeature } from "../rf/txLog.js";

/** The shortest gap between two pings a tool asks for: each one keys the transmitter for a poll. */
export const LINK_PING_MIN_GAP_MS = 10_000;

export interface TerminalToolsOpts {
  host: Pick<ToolHost, "dispatchSession" | "hostEmit" | "hostSubscribe">;
  session: TerminalSession;
  myCall: string;
  /** Why the terminal may not transmit now (no verified callsign, no consent for this tab), or null. */
  txBlocked(): string | null;
  /** The channel the operator has in view, if any. */
  activeChannel(): number | null;
  runRemote: SessionEventsOpts["runRemote"];
  /** Tell the operator something (a ping that could not go out). */
  notice(msg: string): void;
  /** A tool's title, for notices and Recent transmissions. */
  title(tool: string): string;
  log?(msg: string): void;
  now?: () => number;
}

export interface TerminalTools {
  /** Report the session's channels to the tools; call on every session change. */
  sync(): void;
  /** How Recent transmissions names a frame: the tool whose line it carries, if a tool sent it. */
  featureOf(f: Ax25Frame): TxFeature | undefined;
  /** End every session for the tools and stop answering the bus. */
  dispose(): void;
}

const isOpen = (state: string) => state === "connected" || state === "recovering";
/** The bytes TerminalSession sends for a line, as a string: one character per byte. */
const wire = (text: string) => [...`${text}\r`].map((c) => String.fromCharCode(c.charCodeAt(0) & 0xff)).join("");
const bytesText = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};

export function attachTerminalTools(o: TerminalToolsOpts): TerminalTools {
  const { session, host } = o;
  const now = o.now ?? Date.now;
  // the lines tools sent, by their bytes, so the frame that carries one is named after its tool
  const pending = new Map<string, string[]>();

  const events = new SessionEvents({
    host,
    surface: "terminal",
    send: (channel, text, tool) => {
      const key = wire(text);
      pending.set(key, [...(pending.get(key) ?? []), tool].slice(-8));
      if (pending.size > 64) pending.delete(pending.keys().next().value!); // a simulated TNC never reads them
      session.send(channel, text);
    },
    txBlocked: () => o.txBlocked() ?? (session.canTransmit ? null : "transmitting is off for this terminal"),
    runRemote: o.runRemote,
    log: o.log,
    now: o.now,
  });

  session.listener = {
    line: (ch, text) => events.line(ch.id, text),
    rtt: (ch, ms, kind) =>
      host.hostEmit("link.rtt", { ms, kind, peerCall: ch.remoteCall, channel: ch.id, surface: "terminal" }),
  };

  // A ping is one supervisory poll on the open channel: no text, but it keys the transmitter, so it passes the
  // terminal's gate and waits LINK_PING_MIN_GAP_MS after the last one. The answer arrives on `link.rtt`.
  let lastPing = -Infinity;
  const stopPing = host.hostSubscribe("link.ping.request", (_data, from) => {
    const who = o.title(from);
    const open = session.channels.filter((c) => isOpen(c.state));
    const ch = open.find((c) => c.id === o.activeChannel()) ?? open[0];
    if (!ch) return o.notice(`${who}: no connected channel to ping`);
    const why = o.txBlocked();
    if (why) return o.notice(`${who}: ping held, ${why}`);
    if (now() - lastPing < LINK_PING_MIN_GAP_MS)
      return o.notice(`${who}: ping held, one every ${LINK_PING_MIN_GAP_MS / 1000} s`);
    if (!session.probe(ch.id)) return o.notice(`${who}: ping held, a poll to ${ch.remoteCall} is still out`);
    lastPing = now();
  });

  return {
    sync: () =>
      events.sync(
        session.channels.map((c) => ({
          channel: c.id,
          peerCall: c.remoteCall,
          myCall: o.myCall,
          direction: c.direction,
          open: isOpen(c.state),
        })),
      ),
    featureOf: (f) => {
      if (f.type !== "I" || !f.info) return undefined;
      const key = bytesText(f.info);
      const tools = pending.get(key);
      const tool = tools?.shift();
      if (tools && !tools.length) pending.delete(key);
      return tool ? `Tool ${o.title(tool)}` : undefined;
    },
    dispose: () => {
      stopPing();
      session.listener = {};
      events.closeAll();
      pending.clear();
    },
  };
}
