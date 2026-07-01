/**
 * digipeat.ts — connected-mode AX.25 digipeating (docs/29 F3). Unlike the APRS UI n-N digipeater
 * (@aprsweb/aprs), this repeats ANY frame type (SABM/I/RR/…) so a NET/ROM crosslink or an FBB forward can
 * be relayed hop-by-hop through us. Pure: the ingest supplies decoded frames (with H-bits) and transmits
 * whatever this returns. The rule (AX.25 §6.1.2): find the first via-hop not yet repeated; if it addresses
 * us (our call or an alias), mark it repeated (set the H-bit) and re-transmit; otherwise it is not ours.
 */
import { sameAddr, addrStr, type Ax25Address, type Ax25Frame } from "./frame.js";

/**
 * Digipeat `f` if its next unconsumed via-hop addresses one of `ours` (call + aliases). Returns the frame
 * to transmit (with our hop's H-bit set), or null when the frame is fully repeated or not addressed to us.
 */
export function digipeatAx25(f: Ax25Frame, ours: Ax25Address[]): Ax25Frame | null {
  const digis = f.digis ?? [];
  if (digis.length === 0) return null;                          // no via path → nothing to repeat
  const repeated = f.digisRepeated ?? digis.map(() => false);
  const next = repeated.indexOf(false);                         // first un-repeated hop
  if (next < 0) return null;                                    // every hop already repeated
  if (!ours.some((o) => sameAddr(o, digis[next]!))) return null; // the next hop is not us
  const digisRepeated = repeated.slice();
  digisRepeated[next] = true;
  return { ...f, digis: digis.slice(), digisRepeated };
}

/**
 * A path-independent identity for a frame: endpoints + type + sequence + poll/final, but NOT the via path
 * or its H-bits. Two copies of the same frame at different stages of being digipeated share this key — so a
 * digipeater can recognise "the same frame, heard again after another node repeated it".
 */
export function frameContentKey(f: Ax25Frame): string {
  return `${addrStr(f.src)}>${addrStr(f.dst)}|${f.type}|${f.ns ?? ""}.${f.nr ?? ""}|${f.pf ? 1 : 0}`;
}

/**
 * Viscous-delay bookkeeping for a digipeater (docs/29 F3). A viscous digi holds each repeat for a short
 * delay and *cancels* it if it hears the same frame again in the window — meaning a better-placed digi
 * already carried it, so we stay quiet (the classic fill-in behaviour). Pure + timer-agnostic: the caller
 * owns the real timer and passes its token as `T`; this only tracks which content keys have a repeat pending.
 */
export class ViscousDigi<T> {
  private pending = new Map<string, T>();
  /** Register a pending repeat for `key` with its timer token. */
  schedule(key: string, token: T): void { this.pending.set(key, token); }
  /** A copy of `key` was heard: if a repeat is pending, return its token to cancel (back off); else null. */
  onDuplicate(key: string): T | null { const t = this.pending.get(key); if (t === undefined) return null; this.pending.delete(key); return t; }
  /** The pending repeat for `key` fired (transmitted) — it can no longer be cancelled. */
  fired(key: string): void { this.pending.delete(key); }
  pendingCount(): number { return this.pending.size; }
}
