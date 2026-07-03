// SPDX-License-Identifier: MIT
/**
 * session-server.ts — the connected-mode session server: answer inbound AX.25 connects to
 * our service SSIDs (BBS, NET/ROM node) and bind each to a fresh line app (`BbsSession`/`NodeSession`) via
 * `serveApp`. Pure — it consumes raw inbound frames and emits frames through an injected `send`, so the
 * ingest wires it to a KISS TNC (or an AXUDP port) and the loopback harness drives it headlessly. This is
 * the "answer a connect" half of a node/BBS: a station connects to our SSID, gets the greeting, and drives
 * the command interpreter, one line at a time, until BYE/disconnect.
 */
import { serveApp, type LineApp, type RelayController } from "./link-app.js";
import {
  decodeFrame,
  addrStr,
  sameAddr,
  type Ax25Address,
  type Ax25Frame,
  type LinkConfig,
  type ConnectedLink,
} from "@aprsweb/ax25";

/** A service we answer for: its address (call+SSID) and a factory building the app for each caller.
 *  The factory MAY be async (e.g. a BBS that loads the caller's mail snapshot before greeting) — the
 *  server holds the connect until it resolves; the peer's SABM retransmit covers the warm-up window. */
export interface Service {
  addr: Ax25Address;
  app: (remote: Ax25Address) => LineApp | Promise<LineApp>;
  name?: string;
  /** Route the session onward (NET/ROM connect-through) when the app requests `C <dest>`. */
  onConnect?: (dest: string, relay: RelayController, remote: Ax25Address) => void;
}

export interface SessionServerOpts {
  send: (f: Ax25Frame) => void;
  services: Service[];
  clock?: () => number;
  cfg?: Partial<LinkConfig>;
  maxSessions?: number; // refuse new connects past this (a station can still be served)
  onEvent?: (e: { kind: "connect" | "disconnect" | "refused"; service: string; remote: string }) => void;
}

interface Live {
  link?: ConnectedLink;
  service: Service;
  warming: boolean;
}

export class SessionServer {
  private sessions = new Map<string, Live>();
  constructor(private o: SessionServerOpts) {}

  private key(remote: Ax25Address, svc: Ax25Address): string {
    return `${addrStr(remote)}>${addrStr(svc)}`;
  }

  /** Feed one raw inbound AX.25 frame (wire this to KissTnc.onRaw / AxudpPort.onRaw). */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (f) this.onFrame(f);
  }

  /** Route a decoded frame to its session, standing a new one up on an inbound SABM to a service. */
  onFrame(f: Ax25Frame): void {
    const svc = this.o.services.find((s) => sameAddr(s.addr, f.dst));
    if (!svc) return; // not for one of our services
    // SR-PKT-05: we only speak modulo-8 here (frames are decoded with extended=false). An extended
    // SABME would make the link adopt mod-128 while we keep decoding mod-8 → a REJ-storm livelock.
    // Refuse it with DM so the peer falls back to a plain SABM (mod-8) connect.
    if (f.type === "SABME") {
      this.o.send({ dst: f.src, src: svc.addr, command: false, type: "DM", pf: f.pf });
      return;
    }
    const key = this.key(f.src, svc.addr);
    const live = this.sessions.get(key);
    if (live) {
      live.link?.onReceive(f);
      return;
    } // existing (or warming) session

    if (f.type !== "SABM") return; // no session + not a connect request → ignore
    if (this.o.maxSessions != null && this.sessions.size >= this.o.maxSessions) {
      this.o.onEvent?.({ kind: "refused", service: svc.name ?? addrStr(svc.addr), remote: addrStr(f.src) });
      return; // at capacity — the peer's SABM retransmit / DM handles it
    }
    this.open(svc, f, key);
  }

  /** Stand up a session for an inbound SABM. A sync app factory wires immediately; an async one (BBS mail
   *  warm-up) reserves the slot and wires when it resolves — the peer's SABM retransmit covers the window. */
  private open(svc: Service, sabm: Ax25Frame, key: string): void {
    const remote = sabm.src;
    const slot: Live = { service: svc, warming: true };
    this.sessions.set(key, slot); // reserve the key so a retransmitted SABM doesn't double-open
    const wire = (app: LineApp) => {
      if (!this.sessions.has(key)) return; // torn down while warming
      slot.warming = false;
      slot.link = serveApp(svc.addr, remote, app, {
        send: this.o.send,
        clock: this.o.clock,
        cfg: this.o.cfg,
        onConnect: svc.onConnect ? (dest, relay) => svc.onConnect!(dest, relay, remote) : undefined,
        onState: (s) => {
          if (s === "disconnected") {
            this.sessions.delete(key);
            this.o.onEvent?.({ kind: "disconnect", service: svc.name ?? addrStr(svc.addr), remote: addrStr(remote) });
          }
        },
      });
      this.o.onEvent?.({ kind: "connect", service: svc.name ?? addrStr(svc.addr), remote: addrStr(remote) });
      slot.link.onReceive(sabm); // send UA + greeting from a warm app
    };
    const built = svc.app(remote);
    if (built instanceof Promise) {
      built.then(wire).catch((e) => {
        this.sessions.delete(key); // warm-up failed → drop; the peer retransmits/times out
        console.error(`[session] ${svc.name ?? addrStr(svc.addr)} warm-up failed:`, (e as Error).message);
      });
    } else {
      wire(built); // sync factory → answer immediately
    }
  }

  /** Drive T1/T3 timers on every live link (the ingest calls this on a ~1s interval). */
  poll(): void {
    for (const { link } of this.sessions.values()) link?.poll();
  }

  /** Number of active (incl. warming) sessions (observability / tests). */
  count(): number {
    return this.sessions.size;
  }
}
