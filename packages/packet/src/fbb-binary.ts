// SPDX-License-Identifier: MIT
/**
 * fbb-binary.ts — the F6FBB compressed ("B") forwarding transport: the block framing that carries an
 * LZHUF-B1 message over a connected link once both stations advertise compression in their SID.
 *
 * Where the ASCII session sends a message as `title` / body-lines / `^Z`, the binary session sends it
 * as a framed block stream (see tools/interop/LZHUF-SPEC.md):
 *   SOH <len> <header>          header block — `title \0 offset \0` (offset = resume start, decimal)
 *   STX <len> <data> …          one or more data blocks of the LZHUF-B1 stream (len 0 ⇒ 256 on decode)
 *   EOT <chk>                    end-of-transfer; chk makes the additive sum of every payload byte ≡ 0
 * The checksum accumulates every header + data payload byte (not the SOH/STX/EOT markers or the length
 * bytes), and the trailing byte is its two's-complement so the receiver's running sum lands on zero.
 *
 * Negotiation: the SID flags carry `B` when a station forwards compressed; both peers must advertise it.
 * Proposals then switch from `FB` to `FA`, and the `FS` reply may answer `!<offset>` to resume a message
 * whose first `<offset>` bytes the receiver already holds from an aborted transfer.
 *
 * Pure + zero-I/O: the encoder returns bytes, the decoder is fed bytes and yields completed transfers.
 */
import { lzhufEncodeB1, lzhufDecodeB1, toCrlf } from "./lzhuf.js";

export const SOH = 0x01; // header block marker
export const STX = 0x02; // data block marker
export const EOT = 0x04; // end-of-transfer marker
export const FBB_DATA_BLOCK = 250; // bytes per STX block on send (FBB's data-block size)

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Low-level: frame a header + data payload into an SOH/STX…/EOT block stream with the additive checksum. */
export function encodeBinaryTransfer(header: Uint8Array, data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let chk = 0;
  const push = (b: number) => {
    out.push(b & 0xff);
    chk = (chk + b) & 0xff;
  };
  out.push(SOH, header.length & 0xff);
  for (const b of header) push(b);
  for (let i = 0; i < data.length; i += FBB_DATA_BLOCK) {
    const chunk = data.subarray(i, i + FBB_DATA_BLOCK);
    out.push(STX, chunk.length & 0xff); // chunk.length is 1..250, never 0
    for (const b of chunk) push(b);
  }
  out.push(EOT, (256 - chk) & 0xff);
  return Uint8Array.from(out);
}

/** A completed binary transfer surfaced by the streaming decoder. */
export interface BinaryTransfer {
  header: Uint8Array; // the SOH block payload (title \0 offset \0)
  data: Uint8Array; // the concatenated STX payloads (the LZHUF-B1 stream, from `offset` onward)
  checksumOk: boolean; // the trailing EOT checksum verified
}

type DecState = "type" | "soh-len" | "soh-data" | "stx-len" | "stx-data" | "eot-chk";

/**
 * A streaming decoder for the block stream: feed it received bytes, drain completed transfers. It never
 * grows without bound — a transfer whose data exceeds `maxBytes` aborts (surfaced as checksumOk=false).
 */
export class BinaryTransferDecoder {
  private state: DecState = "type";
  private header: number[] = [];
  private data: number[] = [];
  private chk = 0;
  private need = 0; // bytes remaining in the current block payload
  private ready: BinaryTransfer[] = [];
  private overflow = false;

  constructor(private maxBytes = 1024 * 1024) {}

  /** Feed link bytes; returns any transfers that completed. */
  push(bytes: Uint8Array): BinaryTransfer[] {
    for (const b of bytes) this.byte(b & 0xff);
    if (!this.ready.length) return [];
    const out = this.ready;
    this.ready = [];
    return out;
  }

  private byte(b: number): void {
    switch (this.state) {
      case "type":
        if (b === SOH) this.state = "soh-len";
        else if (b === STX) this.state = "stx-len";
        else if (b === EOT) this.state = "eot-chk";
        // any other byte between transfers is ignored (idle fill / stray CR)
        return;
      case "soh-len":
        this.reset();
        this.need = b; // the header is short (title + offset); 0 is an empty header, never 256
        this.state = this.need ? "soh-data" : "type";
        return;
      case "soh-data":
        this.accum(this.header, b);
        if (--this.need === 0) this.state = "type";
        return;
      case "stx-len":
        this.need = b === 0 ? 256 : b;
        this.state = this.need ? "stx-data" : "type";
        return;
      case "stx-data":
        this.accum(this.data, b);
        if (--this.need === 0) this.state = "type";
        return;
      case "eot-chk": {
        const ok = !this.overflow && ((this.chk + b) & 0xff) === 0;
        this.ready.push({ header: Uint8Array.from(this.header), data: Uint8Array.from(this.data), checksumOk: ok });
        this.reset();
        this.state = "type";
        return;
      }
    }
  }

  private accum(into: number[], b: number): void {
    this.chk = (this.chk + b) & 0xff;
    if (into.length + 1 > this.maxBytes) {
      this.overflow = true;
      return; // stop buffering but keep counting the checksum so we consume the block cleanly
    }
    into.push(b);
  }

  private reset(): void {
    this.header = [];
    this.data = [];
    this.chk = 0;
    this.need = 0;
    this.overflow = false;
  }
}

// ---- high-level compressed message (LZHUF-B1 body + block framing) ----

export interface FbbBinaryMessage {
  title: string;
  body: string;
  offset?: number; // resume: the receiver already holds this many bytes of the B1 stream
}

/** The SOH header payload for a message: `title \0 offset \0`. */
function buildHeader(title: string, offset: number): Uint8Array {
  return enc(`${title}\0${offset}\0`);
}

/** Parse the SOH header payload back into its title + resume offset. */
export function parseBinaryHeader(header: Uint8Array): { title: string; offset: number } {
  const s = new TextDecoder().decode(header);
  const [title, off] = s.split("\0");
  return { title: title ?? "", offset: Number(off) || 0 };
}

/**
 * Encode a message for compressed forwarding: compress the CRLF-normalised body with LZHUF-B1, then
 * frame it (from `offset` onward for a resume) behind an SOH header carrying the title + offset.
 */
export function encodeFbbCompressed(m: FbbBinaryMessage): Uint8Array {
  const offset = m.offset ?? 0;
  const stream = lzhufEncodeB1(toCrlf(m.body));
  const data = offset > 0 ? stream.subarray(Math.min(offset, stream.length)) : stream;
  return encodeBinaryTransfer(buildHeader(m.title, offset), data);
}

/** The full LZHUF-B1 stream length for a body — the size a receiver reports it already holds on resume. */
export function fbbCompressedLength(body: string): number {
  return lzhufEncodeB1(toCrlf(body)).length;
}

/**
 * Decode a received binary transfer back into the message. `prior` is the already-held prefix of the B1
 * stream (its length must equal the header's resume offset); the transfer's data is appended before
 * decompression. Returns the decoded body text and whether the B1 CRC verified.
 */
export function decodeFbbCompressed(
  t: BinaryTransfer,
  prior?: Uint8Array,
): { title: string; body: string; crcOk: boolean } {
  const { title, offset } = parseBinaryHeader(t.header);
  const head = prior && offset > 0 ? prior.subarray(0, offset) : new Uint8Array(0);
  const stream = new Uint8Array(head.length + t.data.length);
  stream.set(head, 0);
  stream.set(t.data, head.length);
  const { data, crcOk } = lzhufDecodeB1(stream);
  return { title, body: fromCrlf(data), crcOk: crcOk && t.checksumOk };
}

/** CRLF → LF, the inverse of the body normalisation done before compression. */
function fromCrlf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\r\n/g, "\n");
}

// ---- SID compression negotiation ----

/** Extract the flag characters from an FBB SID `[NAME-VERSION-FLAGS$]` (the `$` BID/MID marker aside). */
export function sidFlags(sid: string): string {
  const m = /\[[^\]]*-([^\]-]*)\]/.exec(sid.trim());
  return (m?.[1] ?? "").replace(/\$/g, "").toUpperCase();
}

/** True when a station's SID advertises compressed forwarding (the `B` flag). */
export function sidHasCompression(sid: string): boolean {
  return sidFlags(sid).includes("B");
}

/** Compressed forwarding runs only when BOTH stations advertise `B`. */
export function compressionAgreed(mySid: string, peerSid: string): boolean {
  return sidHasCompression(mySid) && sidHasCompression(peerSid);
}
