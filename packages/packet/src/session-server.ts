/**
 * session-server.ts — the connected-mode session server (docs/29 F1): answer inbound AX.25 connects to
 * our service SSIDs (BBS, NET/ROM node) and bind each to a fresh line app (`BbsSession`/`NodeSession`) via
 * `serveApp`. Pure — it consumes raw inbound frames and emits frames through an injected `send`, so the
 * ingest wires it to a KISS TNC (or an AXUDP port) and the loopback harness drives it headlessly. This is
 * the "answer a connect" half of a node/BBS: a station connects to our SSID, gets the greeting, and drives
 * the command interpreter, one line at a time, until BYE/disconnect.
 */
import { serveApp, type LineApp } from "./link-app.js";
import { decodeFrame, addrStr, sameAddr, type Ax25Address, type Ax25Frame, type LinkConfig, type ConnectedLink } from "@aprsweb/ax25";

/** A service we answer for: its address (call+SSID) and a factory building the app for each caller. */
export interface Service { addr: Ax25Address; app: (remote: Ax25Address) => LineApp; name?: string }

export interface SessionServerOpts {
  send: (f: Ax25Frame) => void;
  services: Service[];
  clock?: () => number;
  cfg?: Partial<LinkConfig>;
  maxSessions?: number;                 // refuse new connects past this (a station can still be served)
  onEvent?: (e: { kind: "connect" | "disconnect" | "refused"; service: string; remote: string }) => void;
}

interface Live { link: ConnectedLink; service: Service }

export class SessionServer {
  private sessions = new Map<string, Live>();
  constructor(private o: SessionServerOpts) {}

  private key(remote: Ax25Address, svc: Ax25Address): string { return `${addrStr(remote)}>${addrStr(svc)}`; }

  /** Feed one raw inbound AX.25 frame (wire this to KissTnc.onRaw / AxudpPort.onRaw). */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (f) this.onFrame(f);
  }

  /** Route a decoded frame to its session, standing a new one up on an inbound SABM to a service. */
  onFrame(f: Ax25Frame): void {
    const svc = this.o.services.find((s) => sameAddr(s.addr, f.dst));
    if (!svc) return;                                     // not for one of our services
    const key = this.key(f.src, svc.addr);
    let live = this.sessions.get(key);
    if (!live) {
      if (f.type !== "SABM") return;                      // no session + not a connect request → ignore
      if (this.o.maxSessions != null && this.sessions.size >= this.o.maxSessions) {
        this.o.onEvent?.({ kind: "refused", service: svc.name ?? addrStr(svc.addr), remote: addrStr(f.src) });
        return;                                           // at capacity — let T1 retry / the DM path handle it
      }
      const link = serveApp(svc.addr, f.src, svc.app(f.src), {
        send: this.o.send, clock: this.o.clock, cfg: this.o.cfg,
        onState: (s) => {
          if (s === "disconnected") {
            this.sessions.delete(key);
            this.o.onEvent?.({ kind: "disconnect", service: svc.name ?? addrStr(svc.addr), remote: addrStr(f.src) });
          }
        },
      });
      live = { link, service: svc };
      this.sessions.set(key, live);
      this.o.onEvent?.({ kind: "connect", service: svc.name ?? addrStr(svc.addr), remote: addrStr(f.src) });
    }
    live.link.onReceive(f);
  }

  /** Drive T1/T3 timers on every live link (the ingest calls this on a ~1s interval). */
  poll(): void { for (const { link } of this.sessions.values()) link.poll(); }

  /** Number of active sessions (observability / tests). */
  count(): number { return this.sessions.size; }
}
