// SPDX-License-Identifier: MIT
/**
 * route.ts — read the path of a TNC2 line into the legs a packet travelled (pure).
 *
 * A path is the AX.25 digipeater list, then, on a line that reached APRS-IS, the q-construct a server added and
 * the station or server named after it:
 *
 *   OE6ABC>APRS,OE6XGR-2*,WIDE2-1,qAR,OE6XGR-10:…   two digipeater requests, the first taken; IGate OE6XGR-10
 *   OE6ABC>APRS,TCPIP*,qAC,T2AUSTRIA:…                 written straight to APRS-IS; server T2AUSTRIA
 *
 * Only the last digipeater a frame went through carries the `*` (the AX.25 H bit, "has been repeated"); every
 * entry before it was taken too. An entry after it is a request no digipeater fulfilled. A generic request
 * (`WIDE2-1`, `RELAY`) names no station; a digipeater that serves it inserts its own call before it, so a
 * traced path names who repeated the frame, and a used generic request with no call before it was repeated by a
 * station the path does not name.
 */

/** One entry of the digipeater path. */
export interface PathDigi {
  /** The entry without its `*`: a callsign (`OE6XGR-2`) or a generic request (`WIDE2-1`). */
  call: string;
  /** The frame went through this entry: it, or an entry after it, carries the `*`. */
  used: boolean;
  /** A generic request (`WIDEn-N`, `RELAY`, `TRACE`…) rather than a station's callsign. */
  generic: boolean;
}

/** A path split into its legs. */
export interface SplitPath {
  /** The AX.25 digipeater path, in the order the frame travelled it; `TCPIP` and the q-construct excluded. */
  digis: PathDigi[];
  /** `TCPIP` or `TCPXX` in the path: the sender wrote the line to APRS-IS, not on the air. */
  internet: boolean;
  /** The q-construct an APRS-IS server added (`qAR`, `qAC`…), when the line reached APRS-IS. */
  q?: string;
  /**
   * What the q-construct names: the IGate that heard the frame (`qAR`, `qAO`), the server the sender connected
   * to (`qAC`, `qAS`, `qAU`), or the servers a trace passed (`qAI`). Empty when it names none.
   */
  qVia: string[];
}

/** The q-constructs an IGate adds to a frame it heard on the air. */
const RF_Q = new Set(["qAR", "qAr", "qAO", "qAo"]);

/** Path tokens that are instructions, not stations. */
const NAMED_ALIASES = new Set(["WIDE", "RELAY", "TRACE", "ECHO", "GATE", "NOGATE", "RFONLY"]);

/** A generic request: a named alias, or an n-N request (`WIDE2-1`, `WIDE2` once used up, `OE2-2`). */
export function isGenericHop(call: string): boolean {
  const base = call.toUpperCase().split("-")[0] ?? "";
  return NAMED_ALIASES.has(base) || /^[A-Z]{1,5}[1-7]$/.test(base);
}

/** The q-construct in a path token, when it is one (`qAR`, `qAo`…). */
export const isQConstruct = (token: string): boolean => /^q[A-Z][A-Za-z]$/.test(token);

/** `qAR`, `qAr`, `qAO`, `qAo`: the IGate says it heard the frame on the air. */
export const isRfQConstruct = (q: string | undefined): boolean => !!q && RF_Q.has(q);

/** Split a TNC2 path (an array, or the comma-joined form the gateway stores) into its legs. */
export function splitPath(path: string | readonly string[] | null | undefined): SplitPath {
  const tokens = (typeof path === "string" ? path.split(",") : (path ?? [])).map((t) => t.trim()).filter(Boolean);
  const qAt = tokens.findIndex(isQConstruct);
  const before = qAt < 0 ? tokens : tokens.slice(0, qAt);
  const q = qAt < 0 ? undefined : tokens[qAt];
  const qVia = qAt < 0 ? [] : tokens.slice(qAt + 1).map((t) => t.replace(/\*$/, ""));
  let internet = false;
  const entries: { call: string; star: boolean }[] = [];
  for (const t of before) {
    const call = t.replace(/\*$/, "");
    const base = call.toUpperCase().split("-")[0];
    if (base === "TCPIP" || base === "TCPXX") {
      internet = true;
      continue;
    }
    entries.push({ call, star: t.endsWith("*") });
  }
  const lastUsed = entries.reduce((at, e, i) => (e.star ? i : at), -1);
  return {
    digis: entries.map((e, i) => ({ call: e.call, used: i <= lastUsed, generic: isGenericHop(e.call) })),
    internet,
    ...(q ? { q } : {}),
    qVia,
  };
}
