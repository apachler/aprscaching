import { digipeat, dedupeKey } from "@aprsweb/aprs";
import type { ParsedFrame } from "@aprsweb/aprs";
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
