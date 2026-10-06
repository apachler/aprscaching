// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Opt-in outbound text to a MeshCom node over ExtUDP, for LoRa transmission.
 *
 * Off unless the operator enables it and names their own callsign, which must be the call the target
 * node transmits under: the node sends every message as itself, so software can only ever transmit under
 * the licensed operator's call. That call passes the box's transmit gate like any RF port's: the gateway
 * confirms it control-verified and held by the box's operator. Direct messages to a callsign only (the encoder refuses groups and `*`),
 * only to configured node addresses, through a conservative token bucket because LoRa airtime is shared.
 * Every attempt is audited without its text. ExtUDP has no acknowledgement, so the best outcome is
 * "handed to node" — never "delivered"; the node reports refusals (QRS/QRT) back on the listener.
 *
 * Node and Bun only.
 */
import dgram from "node:dgram";
import { appendFile } from "node:fs/promises";
import { encodeMeshcomText, type MeshcomEncodeReason } from "@aprscaching/aprs";
import { MESHCOM_PORT, type MeshcomNode } from "./meshcom.js";
import { TokenBucket } from "./txlimit.js";

export interface MeshcomSenderOpts {
  enabled: boolean;
  /** The licensed operator's callsign; must match the target node's call (base call, any SSID). */
  operatorCall?: string;
  nodes: MeshcomNode[];
  /** Token bucket: `burst` sends at once (default 3), one more every `refillSec` (default 60). */
  burst?: number;
  refillSec?: number;
  /** JSON-lines audit file; unset = audit to the log only. */
  auditPath?: string;
  port?: number;
  /**
   * The box's transmit gate (callverify.ts): why the gateway does not confirm a call for this box now, or null.
   * The operator's call must pass it like any RF port's.
   */
  gate?: (call: string) => string | null;
}

export interface MeshcomSendRequest {
  dst: string;
  text: string;
  /** The feature asking to transmit, recorded in the audit trail. */
  feature: string;
  /** Node address; defaults to the first configured node. */
  node?: string;
}

export type MeshcomSendRefusal =
  | "disabled"
  | "no-operator-call"
  | "node-not-allowlisted"
  | "node-call-unknown"
  | "call-mismatch"
  | "call-not-confirmed"
  | "rate-limited"
  | "socket-error"
  | MeshcomEncodeReason;

export type MeshcomSendOutcome =
  | { ok: true; status: "handed-to-node"; node: string; dst: string; bytes: number }
  | { ok: false; reason: MeshcomSendRefusal };

export interface MeshcomAuditEntry {
  at: string;
  feature: string;
  node: string | null;
  dst: string;
  bytes: number | null;
  outcome: string;
}

type SendFn = (datagram: string, port: number, host: string) => Promise<void>;

const baseCall = (c: string) => c.trim().toUpperCase().split("-")[0]!;

export class MeshcomSender {
  private bucket: TokenBucket;
  private sock?: dgram.Socket;

  constructor(
    private o: MeshcomSenderOpts,
    private deps: {
      now?: () => number;
      send?: SendFn;
      audit?: (e: MeshcomAuditEntry) => Promise<void> | void;
    } = {},
  ) {
    this.bucket = new TokenBucket({ burst: o.burst ?? 3, refillSec: o.refillSec ?? 60, now: () => this.now() });
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async audit(req: MeshcomSendRequest, node: string | null, bytes: number | null, outcome: string) {
    const entry: MeshcomAuditEntry = {
      at: new Date(this.now()).toISOString(),
      feature: req.feature,
      node,
      dst: req.dst,
      bytes,
      outcome,
    };
    if (this.deps.audit) return this.deps.audit(entry);
    console.log("[meshcom] tx %s", JSON.stringify(entry));
    if (this.o.auditPath) await appendFile(this.o.auditPath, JSON.stringify(entry) + "\n").catch(() => {});
  }

  private sendDatagram: SendFn = (datagram, port, host) => {
    if (this.deps.send) return this.deps.send(datagram, port, host);
    this.sock ??= dgram.createSocket("udp4");
    const sock = this.sock;
    return new Promise((resolve, reject) => sock.send(datagram, port, host, (e) => (e ? reject(e) : resolve())));
  };

  async send(req: MeshcomSendRequest): Promise<MeshcomSendOutcome> {
    const refuse = async (reason: MeshcomSendRefusal, node: string | null = null, bytes: number | null = null) => {
      await this.audit(req, node, bytes, reason);
      return { ok: false as const, reason };
    };
    if (!this.o.enabled) return refuse("disabled");
    if (!this.o.operatorCall) return refuse("no-operator-call");
    const node = req.node ? this.o.nodes.find((n) => n.ip === req.node) : this.o.nodes[0];
    if (!node) return refuse("node-not-allowlisted", req.node ?? null);
    if (!node.call) return refuse("node-call-unknown", node.ip);
    if (baseCall(node.call) !== baseCall(this.o.operatorCall)) return refuse("call-mismatch", node.ip);
    if (this.o.gate?.(this.o.operatorCall.trim().toUpperCase())) return refuse("call-not-confirmed", node.ip);

    const enc = encodeMeshcomText(req.dst, req.text);
    if (!enc.ok) return refuse(enc.reason, node.ip);
    if (!this.bucket.take()) return refuse("rate-limited", node.ip, enc.bytes);

    try {
      await this.sendDatagram(enc.datagram, this.o.port ?? MESHCOM_PORT, node.ip);
    } catch {
      return refuse("socket-error", node.ip, enc.bytes);
    }
    await this.audit(req, node.ip, enc.bytes, "handed-to-node");
    return { ok: true, status: "handed-to-node", node: node.ip, dst: enc.dst, bytes: enc.bytes };
  }

  close(): void {
    try {
      this.sock?.close();
    } catch {
      // already closed
    }
    this.sock = undefined;
  }
}
