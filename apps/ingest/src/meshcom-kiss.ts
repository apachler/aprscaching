// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A MeshCom node's KISS port, used for one thing: sending the gateway's answers and Mailbox messages from the
 * service call itself, so a player's thread stays with the address they messaged.
 *
 * The node accepts a frame only from a call of its own base call, any SSID, and puts that call on the air.
 * It answers every frame with a result on KISS port 15, and turns a station's ack of a numbered message back
 * into the number this client sent. Its other frames are never hearings of this box: a frame the MeshCom
 * server relayed arrives with an empty path, as if heard directly, so the box listens to the node over
 * ExtUDP and takes only acks to the service call from here.
 *
 * The service call passes the box's transmit gate like any RF port's call (callverify.ts).
 *
 * The box sends through a node only with its KISS password on (`--kiss auth on` and `--passwd`): without
 * it, anyone on the LAN could transmit under the operator's call. The node then opens with `NONCE: <hex>`
 * and takes the hex HMAC-SHA256 of the nonce, keyed with the password. A node that opens without a nonce
 * is left alone.
 *
 * Node and Bun only.
 */
import net from "node:net";
import { createHmac } from "node:crypto";
import { decodeAx25, encodeAx25, KissDecoder, kissWrap, decodeAprs } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";

export interface MeshcomKissOpts {
  host: string;
  port: number;
  password: string;
  /** The node's own call: the box sends only from calls of its base call. */
  nodeCall: string;
  retryMs?: number;
  /** How long to wait for the node's nonce before taking it as a node without a password. */
  authWaitMs?: number;
  log?: Pick<Console, "log" | "error">;
  /** The box's transmit gate (callverify.ts): why the gateway does not confirm a call for this box, or null. */
  gate?: (call: string) => string | null;
}

/** The node's verdict on one frame (KISS port 15). */
export type KissTxResult = "queued" | "bad-call" | "tx-off" | "bad-frame" | "rate-limited" | "no-answer";
const TXRES: Record<number, KissTxResult> = {
  1: "queued",
  2: "bad-call",
  3: "tx-off",
  4: "bad-frame",
  5: "rate-limited",
};

const baseOf = (c: string) => (c.toUpperCase().split("-")[0] ?? "").trim();
/** The KISS type byte of the node's TX result: port 15, data. */
const TXRES_TYPE = 0xf0;

export class MeshcomKiss {
  private sock?: net.Socket;
  private state: "down" | "auth" | "ready" | "refused" = "down";
  private text = "";
  private rx = new KissDecoder();
  private backoff: Backoff;
  private authTimer?: ReturnType<typeof setTimeout>;
  private waiting: ((r: KissTxResult) => void)[] = [];
  private serviceCall?: string;
  private log: Pick<Console, "log" | "error">;

  constructor(
    private o: MeshcomKissOpts,
    /** An ack a station sent to the service call, its number as this box sent it. */
    private onAck: (from: string, msgNo: string) => void,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 5000 });
    this.log = o.log ?? console;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.state = "down";
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    if (this.authTimer) clearTimeout(this.authTimer);
  }

  /** The gateway's service call: acks to it are passed on. */
  setServiceCall(call: string): void {
    this.serviceCall = call.toUpperCase();
  }

  /** Is the link up and authenticated? */
  ready(): boolean {
    return this.state === "ready";
  }

  /**
   * Can it send from `from`? Only an authenticated link, only a call of the node's base call, and only a call
   * the box's transmit gate passes.
   */
  canSend(from: string): boolean {
    return (
      this.state === "ready" && baseOf(from) === baseOf(this.o.nodeCall) && !this.o.gate?.(from.trim().toUpperCase())
    );
  }

  /**
   * Send an APRS message info field (`:ADDRESSEE:text{nn`, or an ack `:ADDRESSEE:ack12`) from `from`, and
   * resolve with the node's verdict.
   */
  send(from: string, info: string): Promise<KissTxResult> {
    if (!this.canSend(from) || !this.sock) return Promise.resolve("no-answer");
    const frame = encodeAx25({ src: from.toUpperCase(), dst: "APZACG", path: [], payload: info });
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.waiting.indexOf(done);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve("no-answer");
      }, 5000);
      const done = (r: KissTxResult) => {
        clearTimeout(t);
        resolve(r);
      };
      this.waiting.push(done);
      this.sock!.write(kissWrap(frame));
    });
  }

  private connect(): void {
    this.sock?.removeAllListeners();
    this.sock?.destroy();
    this.text = "";
    this.rx.reset();
    this.state = "auth";
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => {
      this.backoff.reset();
      this.authTimer = setTimeout(() => this.refuse("it sent no password challenge"), this.o.authWaitMs ?? 4000);
    });
    s.on("data", (chunk: Buffer) => (this.state === "auth" ? this.authData(chunk) : this.frameData(chunk)));
    s.on("error", () => {});
    s.on("close", () => {
      if (this.authTimer) clearTimeout(this.authTimer);
      for (const w of this.waiting.splice(0)) w("no-answer");
      if (this.state === "refused") return;
      this.state = "down";
      setTimeout(() => this.connect(), this.backoff.next());
    });
  }

  /** A node without a password, or a wrong one: no transmit through it until the box restarts. */
  private refuse(why: string): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.state = "refused";
    this.sock?.destroy();
    this.log.error(
      `[meshcom-kiss] not sending through ${this.o.host}:${this.o.port}: ${why}. Switch on the node's KISS password (--kiss auth on, --passwd) and set MESHCOM_KISS_PASS to it; answers go out under the node's call meanwhile.`,
    );
  }

  private authData(chunk: Buffer): void {
    this.text += chunk.toString("latin1");
    if (this.text.length > 256) return this.refuse("it sent no password challenge");
    for (;;) {
      const i = this.text.indexOf("\n");
      if (i < 0) return;
      const line = this.text.slice(0, i).replace(/\r$/, "");
      this.text = this.text.slice(i + 1);
      const nonce = /^NONCE: ([0-9a-f]{32})$/i.exec(line);
      if (nonce) {
        const mac = createHmac("sha256", this.o.password).update(Buffer.from(nonce[1]!, "hex")).digest("hex");
        this.sock?.write(`${mac}\r\n`);
      } else if (line === "OK") {
        if (this.authTimer) clearTimeout(this.authTimer);
        this.state = "ready";
        this.log.log(
          `[meshcom-kiss] sending through ${this.o.host}:${this.o.port} as calls of ${baseOf(this.o.nodeCall)}`,
        );
        if (this.text) this.frameData(Buffer.from(this.text, "latin1"));
        this.text = "";
        return;
      } else if (line === "FAIL") {
        return this.refuse("the node refused MESHCOM_KISS_PASS");
      } else {
        return this.refuse("it sent no password challenge");
      }
    }
  }

  private frameData(chunk: Buffer): void {
    for (const k of this.rx.push(chunk)) {
      if (((k.port << 4) | k.command) === TXRES_TYPE) {
        this.waiting.shift()?.(TXRES[k.frame[0] ?? 0] ?? "bad-frame");
        continue;
      }
      if (k.port !== 0 || k.command !== 0 || !this.serviceCall) continue;
      const f = decodeAx25(k.frame);
      if (!f) continue;
      const d = decodeAprs(f) as { kind?: string; ack?: boolean; addressee?: string; msgNo?: string };
      if (d.kind === "message" && d.ack && d.msgNo && d.addressee?.trim().toUpperCase() === this.serviceCall)
        this.onAck(f.src.toUpperCase(), d.msgNo);
    }
  }
}
