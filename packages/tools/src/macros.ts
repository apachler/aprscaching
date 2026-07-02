/**
 * macros.ts — Graphic-Packet / LinPac-style macro variable expansion (docs/28 C). One shared expander
 * so every surface (packet terminal, BBS, tools console) and every command Tool substitutes the same
 * `{token}` set. Pure substitution: only provided vars are replaced; unknown `{tokens}` are left intact.
 */
export interface MacroVars {
  call?: string;    // the operator's callsign (station in use)
  mycall?: string;  // alias for call (GP {mycall})
  peer?: string;    // the far station on the active channel
  chan?: string;    // active channel's remote call (GP {chan})
  grid?: string;    // Maidenhead locator, when known
  date?: string;    // caller-supplied date string
  time?: string;    // caller-supplied time string
  [k: string]: string | undefined;
}

/** Replace `{token}` occurrences with the matching var; leaves unknown tokens untouched (GP behaviour). */
export function expand(text: string, vars: MacroVars = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** Fill date/time from a Date (defaults to now) without clobbering explicitly-provided vars — for app use. */
export function withNow(vars: MacroVars, now = new Date()): MacroVars {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}Z`,
    ...vars,
  };
}
