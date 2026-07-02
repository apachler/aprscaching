import { decodeAx25 } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

/**
 * axip.ts — AXIP listener: AX.25 frames encapsulated directly in **IP protocol 93** (the JNOS/BPQ AXIP
 * mode), as opposed to AXUDP (axudp.ts), which wraps the same frames in UDP port 10093. RESERVED seam
 * (docs/22 §1A #2 — "AXIP is Phase 2+"): wired but feature-flagged off; start only when AXIP_ENABLE is set.
 *
 * The one thing genuinely different from AXUDP: a raw proto-93 socket delivers the **whole IP datagram
 * including the IP header** (a UDP socket hands you just the payload), so we strip the IPv4 header before
 * decoding the AX.25 frame. The rest is identical — and identically trust-neutral: a tunnelled frame is
 * `heardVia: "aprs_is"` on the `axip` port, so the gateway's provenance derivation stamps
 * `firstPartyAttested = false` and it can NEVER reach Tier A. "Transport convenience is not trust uplift."
 *
 * Node has no built-in raw-IP socket, so the actual capture uses the optional `raw-socket` native package
 * (loaded dynamically; absent → the listener logs and stays inert). The decode/normalize below is pure and
 * unit-tested; only the raw-socket bind is validate-at-deploy (and needs CAP_NET_RAW / root).
 */

/** Strip an IPv4 header, returning the payload (the AX.25 frame), or null if it isn't a v4 datagram. */
export function stripIpv4Header(datagram: Uint8Array): Uint8Array | null {
  if (datagram.length < 20) return null;               // minimum IPv4 header
  if ((datagram[0]! >> 4) !== 4) return null;          // version must be 4
  const ihl = (datagram[0]! & 0x0f) * 4;               // header length (32-bit words → bytes)
  if (ihl < 20 || ihl > datagram.length) return null;
  return datagram.subarray(ihl);
}

/**
 * PURE: normalize one AXIP datagram into a Tier-C ingest Packet, or null. Prefers stripping the IPv4 header
 * (raw proto-93 sockets include it); falls back to treating the datagram as a bare AX.25 frame for stacks
 * that hand over the payload only. The Tier-C mapping (`heardVia:"aprs_is"`, `port:"axip"`) is fixed here so
 * a tunnelled frame can never be first-party attested, exactly like the AXUDP path.
 */
export function axipToPacket(datagram: Uint8Array, nowS = Math.floor(Date.now() / 1000)): Packet | null {
  const stripped = stripIpv4Header(datagram);
  const f = (stripped && decodeAx25(stripped)) || decodeAx25(datagram);
  if (!f) return null;
  return {
    src: f.src, dst: f.dst, path: f.path, payload: f.payload,
    kind: "other", heardVia: "aprs_is", port: "axip",   // tunnelled → never first-party attested
    ts: nowS, raw: f.raw,
  };
}

export interface AxipOpts { bind?: string }

/** The tiny slice of the optional `raw-socket` API we use (kept local so the dep stays out of the build). */
interface RawSocket { on(ev: string, cb: (arg: unknown) => void): void; close?(): void }
interface RawSocketModule { createSocket(opts: { protocol: number }): RawSocket }

/** RX-only AXIP listener over a raw IP proto-93 socket (opt-in; tunnelled frames stay Tier C). */
export class AxipListener {
  private sock?: RawSocket;
  constructor(private o: AxipOpts, private onPacket: (p: Packet) => void) {}

  async start(): Promise<void> {
    let raw: RawSocketModule;
    const pkg = "raw-socket";                            // dynamic + non-literal so tsc doesn't require the dep
    try { raw = (await import(pkg)) as RawSocketModule; }
    catch { console.warn("[axip] optional 'raw-socket' package not installed — AXIP RX disabled (npm i raw-socket, needs CAP_NET_RAW)"); return; }
    const AX25_PROTO = 93;
    const s = raw.createSocket({ protocol: AX25_PROTO });
    this.sock = s;
    s.on("message", (buf: unknown) => {
      const p = axipToPacket(Uint8Array.from(buf as Buffer));
      if (p) this.onPacket(p);
    });
    s.on("error", (e: unknown) => console.error("[axip] socket error:", (e as Error).message));
    console.log(`[axip] listening IP proto/${AX25_PROTO}${this.o.bind ? ` on ${this.o.bind}` : ""} (tunnelled AX.25 — Tier C only)`);
  }
}
