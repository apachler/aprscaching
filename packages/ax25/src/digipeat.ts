/**
 * digipeat.ts — connected-mode AX.25 digipeating (docs/29 F3). Unlike the APRS UI n-N digipeater
 * (@aprsweb/aprs), this repeats ANY frame type (SABM/I/RR/…) so a NET/ROM crosslink or an FBB forward can
 * be relayed hop-by-hop through us. Pure: the ingest supplies decoded frames (with H-bits) and transmits
 * whatever this returns. The rule (AX.25 §6.1.2): find the first via-hop not yet repeated; if it addresses
 * us (our call or an alias), mark it repeated (set the H-bit) and re-transmit; otherwise it is not ours.
 */
import { sameAddr, type Ax25Address, type Ax25Frame } from "./frame.js";

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
