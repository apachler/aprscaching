/**
 * netromnode.ts — the operator-local NET/ROM node RF wiring (docs/29 F2). Drives the pure `NetromNode`
 * engine over a KISS TNC: periodically transmits our NODES broadcast (UI → "NODES", PID 0xCF), consumes
 * inbound NODES broadcasts to learn routes, decays obsolescence, and mirrors the learned table + MHeard
 * up to the gateway (the workbench node view reads them). The connected-mode node *session* (a user
 * connecting in and issuing C <dest> to route through us) rides the same KISS link and is validate-at-deploy.
 */
import { NetromNode, type LearnedRoute } from "@aprsweb/packet";
import { decodeFrame, parseAddr, addrStr, PID_NETROM } from "@aprsweb/ax25";
import type { KissTnc } from "./kiss.js";

const NODES_DST = { call: "NODES", ssid: 0 };

export interface NetromNodeOpts {
  mycall: string; alias: string; port?: string;
  broadcastMs?: number; decayMs?: number; pathQuality?: number;
  gatewayBase?: string; secret?: string;   // mirror learned nodes + mheard to the gateway
}

export class NetromNodeRunner {
  private node: NetromNode;
  private port: string;
  constructor(private kiss: KissTnc, private o: NetromNodeOpts) {
    this.node = new NetromNode({ call: parseAddr(o.mycall), alias: o.alias }, { pathQuality: o.pathQuality });
    this.port = o.port ?? "kiss-tnc";
  }

  start(): void {
    const bMs = this.o.broadcastMs ?? 300_000;   // NET/ROM default NODES interval ≈ 5 min
    const dMs = this.o.decayMs ?? bMs;
    this.broadcast();
    setInterval(() => this.broadcast(), bMs);
    setInterval(() => this.node.decay(), dMs);
    console.log(`[netrom] node ${this.o.alias}:${this.o.mycall} active on ${this.port}`);
  }

  /** Feed a raw inbound AX.25 frame (wire this to KissTnc.onRaw). Learns from NODES broadcasts. */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f || f.type !== "UI" || f.pid !== PID_NETROM) return;
    if (f.dst.call !== NODES_DST.call || !f.info) return;
    const learned = this.node.consume(f.info, f.src, this.port);
    if (learned) { console.log(`[netrom] learned ${learned} route(s) from ${addrStr(f.src)}`); void this.mirror(); }
  }

  /** Transmit our NODES broadcast frame(s). */
  private broadcast(): void {
    for (const info of this.node.broadcast())
      this.kiss.sendFrame({ dst: NODES_DST, src: parseAddr(this.o.mycall), command: true, type: "UI", pf: false, pid: PID_NETROM, info });
  }

  /** Mirror the learned table + MHeard to the gateway node surface (best-effort). */
  private async mirror(): Promise<void> {
    if (!this.o.gatewayBase || !this.o.secret) return;
    const post = (path: string, body: unknown) =>
      fetch(`${this.o.gatewayBase}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret! }, body: JSON.stringify(body) }).catch(() => {});
    for (const r of this.node.list()) await this.postNode(post, r);
  }
  private postNode(post: (p: string, b: unknown) => Promise<unknown>, r: LearnedRoute): Promise<unknown> {
    return post("/api/node/nodes", { dest: addrStr(r.dest), alias: r.alias, neighbor: addrStr(r.neighbor), quality: r.quality, port: r.port ?? this.port });
  }
}
