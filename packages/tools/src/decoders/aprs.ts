// SPDX-License-Identifier: MIT
/**
 * aprs.ts — the packet decoder: a raw TNC2 monitor line or APRS-IS line in, the AX.25 header and every APRS
 * field it carries out. It runs the same pure parser the gateway ingests with (`@aprscaching/aprs`), in the
 * browser, so it decodes with no network. `decodeAprsLine` gives the structured result a surface renders as
 * fields; `decodeAprsText` is the plain-text form a tool decoder returns.
 */
import { classifyQ, decodeAprs, parseTNC2 } from "@aprscaching/aprs";

/** A decoded line: the frame header plus the typed APRS data (`kind` names the packet type). */
export interface AprsDecode {
  ok: true;
  frame: { src: string; dst: string; path: string[]; payload: string; heardVia: string; igateCall?: string };
  data: Record<string, unknown> & { kind: string };
}
export type AprsDecodeResult = AprsDecode | { ok: false; error: string };

/** Decode one raw line (the first non-empty line of `input`). */
export function decodeAprsLine(input: string): AprsDecodeResult {
  const raw =
    input
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (!raw) return { ok: false, error: "Paste a raw TNC2 or APRS-IS line." };
  const frame = parseTNC2(raw);
  if (!frame) return { ok: false, error: "Not a TNC2 line: expected SOURCE>DEST,PATH:payload." };
  const q = classifyQ(frame.path);
  const data = decodeAprs(frame) as unknown as Record<string, unknown> & { kind: string };
  return {
    ok: true,
    frame: {
      src: frame.src,
      dst: frame.dst,
      path: frame.path,
      payload: frame.payload,
      heardVia: q.heardVia,
      ...(q.igateCall ? { igateCall: q.igateCall } : {}),
    },
    data,
  };
}

/** The decoded APRS fields as display strings, `kind` left out (a surface shows it as the heading). */
export function aprsFields(data: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "kind" || v == null) continue;
    if (typeof v === "object") {
      const sym = v as { label?: unknown; table?: unknown; code?: unknown };
      const str = (x: unknown) => (typeof x === "string" ? x : "");
      if (k === "symbol" && typeof sym.label === "string") {
        out.push([k, `${sym.label} (${str(sym.table)}${str(sym.code)})`]);
        continue;
      }
      out.push([k, JSON.stringify(v)]);
    } else out.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
  }
  return out;
}

/** The decode as plain text, one field per line — the form a tool decoder returns. */
export function decodeAprsText(input: string): string {
  const r = decodeAprsLine(input);
  if (!r.ok) return r.error;
  const { frame, data } = r;
  return [
    `${frame.src} > ${frame.dst} via ${frame.path.join(",") || "(no path)"}`,
    `heard via: ${frame.heardVia}${frame.igateCall ? ` (${frame.igateCall})` : ""}`,
    `type: ${data.kind}`,
    ...aprsFields(data).map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
}
