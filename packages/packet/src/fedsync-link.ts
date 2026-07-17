// SPDX-License-Identifier: MIT
/**
 * fedsync-link.ts — the connected-mode federation sync binding: pull signed CBOR sync pages over an
 * AX.25 or NET/ROM circuit. It is a LINE protocol on purpose — it rides the same session machinery
 * as the BBS and the node (LineApp over I-frames), works through connect-through, and stays legible
 * on a monitor. Payloads are base64 CBOR; on links that negotiated `deflateDict1`, page payloads are
 * dictionary-compressed before base64 (an injected codec — the compression runtime is driver-owned).
 *
 *   server greets:  ACSL1 H <b64(cbor caps)>          both ends intersect caps deterministically
 *   client:         ACSL1 H <b64(cbor caps)>
 *   client:         ACSL1 R <b64(cbor {1 type, 2 since, 3 limit})>
 *   server:         ACSL1 P <b64(page bytes)>         one page per request — half-duplex-friendly
 *   either:         ACSL1 E <text>                    protocol error, human-readable
 *
 * Trust is unchanged: a page is signed fedwire frames, verified by the receiving GATEWAY exactly as
 * an HTTP pull — this binding is pure transport and holds no keys.
 */
import {
  cborEncode,
  cborDecode,
  toCborValue,
  fromCborValue,
  LinkCaps,
  negotiateCaps,
  FED_DEFLATE_DICT_ID,
  type CborMap,
  type CborValue,
} from "@aprsweb/shared";
import type { LineApp, LineReply } from "./link-app.js";

const MAGIC = "ACSL1";
/** A reply line must clear the session driver's 8 KiB line bound with margin for the prefix. */
const MAX_LINE_PAYLOAD_B64 = 7000;

/** Optional payload codec for the negotiated compression (driver-owned runtime, e.g. Node zlib). */
export interface LinkPayloadCodec {
  compress(payload: Uint8Array): Uint8Array;
  decompress(payload: Uint8Array): Uint8Array | null;
}

/** Serve one page of signed sync frames: the raw CBOR page bytes, or null for an unknown feed. */
export type FedPageSource = (type: string, since: number, limit: number) => Promise<Uint8Array | null>;

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(s);
};
const b64decode = (text: string): Uint8Array | null => {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const K_TYPE = 1,
  K_SINCE = 2,
  K_LIMIT = 3;

function capsLine(caps: LinkCaps): string {
  return `${MAGIC} H ${b64encode(cborEncode(toCborValue(caps)))}`;
}
function parseCaps(b64: string): LinkCaps | null {
  const bytes = b64decode(b64);
  if (!bytes) return null;
  try {
    const parsed = LinkCaps.safeParse(fromCborValue(cborDecode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Split an `ACSL1 <T> <payload?>` line; null when it is not ours. */
function parseLine(line: string): { t: string; payload: string } | null {
  const m = /^ACSL1 ([A-Z]) ?(.*)$/.exec(line.trim());
  return m ? { t: m[1]!, payload: m[2] ?? "" } : null;
}

/** The negotiated-compression choice both sides apply to PAGE payloads. */
function pageCompression(negotiated: LinkCaps | null): string {
  return negotiated?.compress[0] ?? "none";
}

// ---------------------------------------------------------------- server side

/**
 * The `aprscaching` service a node advertises: answers HELLO with our caps, then serves one signed
 * page per request from the injected source. Page size self-adjusts: if a page overflows the line
 * budget, the limit halves and the source is asked again — a single oversized record is an error.
 */
export class FedSyncApp implements LineApp {
  private negotiated: LinkCaps | null = null;
  constructor(
    private readonly ours: LinkCaps,
    private readonly source: FedPageSource,
    private readonly codec?: LinkPayloadCodec,
  ) {}

  greeting(): string[] {
    return [capsLine(this.ours)];
  }

  async handle(input: string): Promise<LineReply> {
    const msg = parseLine(input);
    if (!msg) return { lines: [`${MAGIC} E not a fedsync line`] };
    if (msg.t === "H") {
      const theirs = parseCaps(msg.payload);
      if (!theirs) return { lines: [`${MAGIC} E bad caps`], disconnect: true };
      this.negotiated = negotiateCaps(this.ours, theirs);
      if (!this.negotiated) return { lines: [`${MAGIC} E no common profile`], disconnect: true };
      return { lines: [] };
    }
    if (msg.t === "R") {
      if (!this.negotiated) return { lines: [`${MAGIC} E hello first`], disconnect: true };
      const req = this.parseReq(msg.payload);
      if (!req) return { lines: [`${MAGIC} E bad request`] };
      let limit = Math.min(req.limit, this.negotiated.batchMax);
      for (;;) {
        const page = await this.source(req.type, req.since, limit);
        if (!page) return { lines: [`${MAGIC} E unknown feed '${req.type}'`] };
        const payload =
          pageCompression(this.negotiated) === FED_DEFLATE_DICT_ID && this.codec ? this.codec.compress(page) : page;
        const b64 = b64encode(payload);
        if (b64.length <= MAX_LINE_PAYLOAD_B64) return { lines: [`${MAGIC} P ${b64}`] };
        if (limit <= 1) return { lines: [`${MAGIC} E record too large for this link`] };
        limit = Math.max(1, limit >> 1); // page overflowed the line budget → ask for fewer records
      }
    }
    if (msg.t === "E") return { lines: [], disconnect: true };
    return { lines: [`${MAGIC} E unknown command`] };
  }

  private parseReq(b64: string): { type: string; since: number; limit: number } | null {
    const bytes = b64decode(b64);
    if (!bytes) return null;
    try {
      const m = cborDecode(bytes);
      if (!(m instanceof Map)) return null;
      const type = m.get(K_TYPE),
        since = m.get(K_SINCE),
        limit = m.get(K_LIMIT);
      if (typeof type !== "string" || typeof since !== "number" || typeof limit !== "number") return null;
      if (since < 0 || limit < 1 || limit > 10000) return null;
      return { type, since, limit };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- client side

/**
 * The dial side: transport-agnostic (the driver supplies `sendLine` and feeds received lines into
 * `onLine`). One outstanding request at a time — packet circuits are half-duplex in spirit, and the
 * server answers strictly in order.
 */
export class FedSyncLinkClient {
  private negotiated: LinkCaps | null = null;
  private helloWaiter: { resolve: (c: LinkCaps) => void; reject: (e: Error) => void } | null = null;
  private pageWaiter: { resolve: (p: Uint8Array) => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly ours: LinkCaps,
    private readonly io: { sendLine(line: string): void },
    private readonly codec?: LinkPayloadCodec,
  ) {}

  /** Negotiated caps once HELLO completes; null before. */
  caps(): LinkCaps | null {
    return this.negotiated;
  }

  /** Wait for the server's greeting caps, answer with ours, resolve the intersection. */
  hello(): Promise<LinkCaps> {
    return new Promise((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
    });
  }

  /** Pull one page of signed sync frames (raw CBOR page bytes — the gateway verifies them). */
  pull(type: string, since: number, limit: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (!this.negotiated) return reject(new Error("fedsync-link: hello first"));
      if (this.pageWaiter) return reject(new Error("fedsync-link: one request at a time"));
      this.pageWaiter = { resolve, reject };
      const req: CborMap = new Map<number, CborValue>([
        [K_TYPE, type],
        [K_SINCE, since],
        [K_LIMIT, limit],
      ]);
      this.io.sendLine(`${MAGIC} R ${b64encode(cborEncode(req))}`);
    });
  }

  /** Feed one received line from the circuit. */
  onLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return; // node banners etc. — not ours
    if (msg.t === "H") {
      const theirs = parseCaps(msg.payload);
      const w = this.helloWaiter;
      this.helloWaiter = null;
      if (!theirs) {
        w?.reject(new Error("fedsync-link: bad server caps"));
        return;
      }
      this.negotiated = negotiateCaps(this.ours, theirs);
      if (!this.negotiated) {
        w?.reject(new Error("fedsync-link: no common profile"));
        return;
      }
      this.io.sendLine(capsLine(this.ours));
      w?.resolve(this.negotiated);
      return;
    }
    if (msg.t === "P") {
      const w = this.pageWaiter;
      this.pageWaiter = null;
      if (!w) return;
      const raw = b64decode(msg.payload);
      if (!raw) {
        w.reject(new Error("fedsync-link: bad page payload"));
        return;
      }
      const page =
        pageCompression(this.negotiated) === FED_DEFLATE_DICT_ID && this.codec ? this.codec.decompress(raw) : raw;
      if (!page) {
        w.reject(new Error("fedsync-link: page failed decompression"));
        return;
      }
      w.resolve(page);
      return;
    }
    if (msg.t === "E") {
      const err = new Error(`fedsync-link: peer error: ${msg.payload}`);
      const hw = this.helloWaiter,
        pw = this.pageWaiter;
      this.helloWaiter = null;
      this.pageWaiter = null;
      hw?.reject(err);
      pw?.reject(err);
    }
  }
}
