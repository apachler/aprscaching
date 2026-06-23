/**
 * Canonical JSON + the authorship message, shared by every party that must agree byte-for-byte:
 * the web (signs), the gateway (verifies), and federation consumers (re-verify). Keep this tiny
 * and dependency-free.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** The exact bytes a logger signs to attest authorship of a find. v1 fields are fixed + ordered. */
export interface Authorship {
  cache: string;      // cache code (AC-####)
  instance: string;   // home instance id (disambiguates the cache network-wide)
  logger: string;     // logger callsign (UPPER)
  logType: string;    // "found" | ...
  at: number;         // client authorship time (epoch seconds)
}
export function authorshipMessage(a: Authorship): string {
  return stableStringify({ v: 1, cache: a.cache, instance: a.instance, logger: a.logger, logType: a.logType, at: a.at });
}
