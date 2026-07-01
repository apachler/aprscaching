import { digipeat, dedupeKey } from "@aprsweb/aprs";
import type { ParsedFrame } from "@aprsweb/aprs";
import { digipeatAx25, decodeFrame, addrStr, parseAddr, type Ax25Address } from "@aprsweb/ax25";
import type { KissTnc } from "./kiss.js";

/**
 * APRS digipeater over a KISS TNC. For each RF frame heard, compute the n-N repeat (digipeat()) and
 * transmit it — with duplicate suppression so we don't repeat the same payload twice in a window.
 */
export class Digipeater {
  private recent = new Map<string, number>(); // dedupe key -> ts(ms)
  constructor(private kiss: KissTnc, private opts: { mycall: string; aliases?: Set<string>; dedupeMs?: number }) {}

  onFrame(f: ParsedFrame): void {
    const out = digipeat(f, this.opts);
    if (!out) return;
    const window = this.opts.dedupeMs ?? 30000;
    const nowMs = Date.now();
    for (const [k, t] of this.recent) if (nowMs - t > window) this.recent.delete(k);
    const key = dedupeKey(f);
    if (this.recent.has(key)) return;
    this.recent.set(key, nowMs);
    if (this.kiss.send(out)) console.log(`[digi] repeated ${f.src} -> ${out.path.join(",")}`);
  }
}

/**
 * Connected-mode AX.25 digipeater (docs/29 F3). Repeats ANY frame type (SABM/I/RR/…) whose next
 * un-repeated via-hop is our call or an alias — so NET/ROM crosslinks and FBB forwarding relay through
 * us. Wire to KissTnc.onRaw. Duplicate-suppressed; a viscous delay (`viscousMs`) lets a better-placed
 * digi win first (we cancel if we hear the same frame already repeated).
 */
export class ConnectedDigipeater {
  private ours: Ax25Address[];
  private recent = new Map<string, number>();          // dedupe key -> ts(ms)
  constructor(private kiss: KissTnc, private opts: { mycall: string; aliases?: string[]; dedupeMs?: number; viscousMs?: number }) {
    this.ours = [opts.mycall, ...(opts.aliases ?? [])].map((c) => parseAddr(c));
  }

  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f) return;
    const out = digipeatAx25(f, this.ours);
    if (!out) return;
    const window = this.opts.dedupeMs ?? 30_000;
    const nowMs = Date.now();
    for (const [k, t] of this.recent) if (nowMs - t > window) this.recent.delete(k);
    const key = frameKey(f);
    if (this.recent.has(key)) return;                  // already handled this frame this window
    this.recent.set(key, nowMs);
    const tx = () => { if (this.kiss.sendFrame(out)) console.log(`[digi-c] repeated ${addrStr(f.src)}→${addrStr(f.dst)} ${f.type}`); };
    if (this.opts.viscousMs) setTimeout(tx, this.opts.viscousMs); else tx();
  }
}

/** A dedupe key for a connected-mode frame: endpoints + type + sequence (ignores the H-bit progression). */
function frameKey(f: ReturnType<typeof decodeFrame>): string {
  if (!f) return "";
  return `${addrStr(f.src)}>${addrStr(f.dst)}|${f.type}|${f.ns ?? ""}.${f.nr ?? ""}|${f.pf ? 1 : 0}`;
}
