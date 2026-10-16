// SPDX-License-Identifier: MIT
/**
 * framing.ts — the KISS byte stream of one client of a KISS server, and the address fields of the AX.25 frames
 * it carries. The KISS codec itself is `@aprscaching/aprs` (`KissDecoder`, `kissStripCrc`, `kissWrap`); this
 * module adds what a server needs per connection: data frames apart from commands, with a count of each kind
 * it set aside. Pure: no sockets, no clock.
 */
import { KissDecoder, kissStripCrc, kissWrap } from "@aprscaching/aprs";
import { addrStr, decodeAddress } from "@aprscaching/ax25";

/** One KISS data frame from a client: the KISS port it named and the raw AX.25 bytes. */
export interface ClientFrame {
  port: number;
  frame: Uint8Array;
}

/** What a client's stream held besides data frames, counted since the connection opened. */
export interface StreamCounts {
  /** Command frames (TXDELAY, PERSIST, SLOTTIME, TXTAIL, FULLDUPLEX, SETHARDWARE, return-from-KISS). */
  commands: number;
  /** Frames that grew past the size limit without a closing FEND: the stream is not KISS. */
  overflows: number;
}

/** The largest KISS frame a client may send; AX.25 frames are a few hundred bytes. */
export const KISS_CLIENT_MAX_BYTES = 4096;

/**
 * The KISS stream of one client. A frame split across reads is held until its closing FEND. A frame with a
 * SMACK or FlexNet CRC (the Linux `mkiss` driver probes with them) has it removed; a type byte with the SMACK bit
 * whose CRC does not check is a data frame on KISS port 8–15, and is kept as one. Command frames
 * (the type byte's low nibble is not 0, 0xFF return-from-KISS among them) are set aside and counted: the box
 * owns its TNC's timing, and one client must not change the channel access every other client shares.
 */
export class KissClientStream {
  private rx: KissDecoder;
  readonly counts: StreamCounts = { commands: 0, overflows: 0 };
  constructor(maxBytes = KISS_CLIENT_MAX_BYTES) {
    this.rx = new KissDecoder(maxBytes);
  }

  /** Feed one read; returns the data frames it completed. */
  push(chunk: Uint8Array): ClientFrame[] {
    const out: ClientFrame[] = [];
    const before = this.rx.overflows;
    for (const raw of this.rx.push(chunk)) {
      const k = kissStripCrc(raw) ?? raw;
      if (k.command !== 0) {
        this.counts.commands++;
        continue;
      }
      out.push({ port: k.port, frame: k.frame });
    }
    this.counts.overflows += this.rx.overflows - before;
    return out;
  }
}

/** A KISS data frame on `port` carrying `frame`, ready to write to a client. */
export const kissDataFrame = (frame: Uint8Array, port: number): Uint8Array => kissWrap(frame, port);

/** The address fields of an AX.25 frame, each as `CALL` or `CALL-SSID`. */
export interface FrameAddresses {
  dst: string;
  src: string;
  digis: string[];
}

const CALL = /^[A-Z0-9]{1,6}$/;

/**
 * The destination, source and via addresses of any AX.25 frame (UI, connected mode, NET/ROM), or null when the
 * bytes hold no valid address field: fewer than two addresses, more than ten, a call that is not A–Z and 0–9,
 * or no control byte after the last address.
 */
export function frameAddresses(bytes: Uint8Array): FrameAddresses | null {
  const calls: string[] = [];
  let off = 0;
  for (;;) {
    if (calls.length === 10 || off + 7 > bytes.length) return null;
    // a call byte is an ASCII character shifted left: its low bit is never set
    for (let i = 0; i < 6; i++) if (bytes[off + i]! & 1) return null;
    const a = decodeAddress(bytes, off);
    if (!CALL.test(a.addr.call)) return null;
    calls.push(addrStr(a.addr));
    off += 7;
    if (a.last) break;
  }
  if (calls.length < 2 || off >= bytes.length) return null;
  const [dst, src, ...digis] = calls;
  return { dst: dst!, src: src!, digis };
}
