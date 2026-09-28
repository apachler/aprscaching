// SPDX-License-Identifier: MIT
/**
 * Runtime-neutral MeshCom conformance: runs the golden fixtures and a fixed encoder/dedup corpus through
 * the core and reports every mismatch. No filesystem or runtime APIs — the caller supplies the fixtures —
 * so the same bundle runs on Node, Bun and Workers (tools/conformance/meshcom.mjs) and under vitest.
 */
import { decodeMeshcom, encodeMeshcomText, MeshcomDedup, meshcomToAprs, decodeAprs } from "../../src/index.js";

export interface MeshcomFixture {
  name: string;
  description?: string;
  receiver?: string;
  datagram?: string;
  datagramHex?: string;
  expect: Record<string, unknown>;
}

export interface ConformanceResult {
  failures: string[];
  /** Deterministic per-case outputs; identical across runtimes when the core behaves the same. */
  outputs: Record<string, unknown>;
}

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const utf8Len = (s: string) => new TextEncoder().encode(s).byteLength;

/** Flatten an event into the vocabulary the fixtures' `expect` blocks use. */
function view(input: Uint8Array | string, receiver?: string): Record<string, unknown> {
  const r = decodeMeshcom(input, receiver ? { receiverCalls: [receiver] } : {});
  if (!r.ok) return { ok: false, reason: r.reason };
  const e = r.event;
  const p = e.provenance;
  const out: Record<string, unknown> = {
    ok: true,
    type: e.type,
    srcType: p.srcType,
    src: e.src,
    path: p.path,
    rf: p.rf,
    direct: p.direct,
    rawKeys: Object.keys(e.raw),
  };
  for (const k of ["msgId", "rssi", "snr", "firmware"] as const) if (p[k] !== undefined) out[k] = p[k];
  if (e.type === "pos") Object.assign(out, { lat: e.lat, lon: e.lon, locator: e.locator, symbol: e.symbol });
  if (e.type === "msg")
    Object.assign(out, { dst: e.dst, dstKind: e.dstKind, text: e.text, textBytes: utf8Len(e.text) });
  if (e.type === "tele") out.tele = e.values;
  const aprs = meshcomToAprs(e);
  if (aprs) {
    const d = decodeAprs({ src: aprs.src, dst: "APRS", path: aprs.path, payload: aprs.payload, raw: "" }) as {
      kind: string;
    };
    out.aprsKind = d.kind;
  }
  return out;
}

function matches(actual: Record<string, unknown>, key: string, want: unknown): boolean {
  const got = actual[key];
  if (key === "rawKeys") return Array.isArray(want) && want.every((k) => (got as string[]).includes(k as string));
  if (typeof want === "number" && typeof got === "number") return Math.abs(got - want) < 1e-9;
  return JSON.stringify(got) === JSON.stringify(want);
}

/** Encoder limits: bytes, not characters (the firmware measures `strlen`). */
const ENCODE_CASES: [string, string, string, boolean | string][] = [
  ["150 ASCII", "OE8APR-12", "A".repeat(150), true],
  ["151 ASCII", "OE8APR-12", "A".repeat(151), "text-too-long"],
  ["75 umlauts = 150 bytes", "OE8APR-12", "ä".repeat(75), true],
  ["76 umlauts = 152 bytes", "OE8APR-12", "ä".repeat(76), "text-too-long"],
  ["37 emoji + 2 ASCII = 150 bytes", "OE8APR-12", "📡".repeat(37) + "73", true],
  ["38 emoji = 152 bytes", "OE8APR-12", "📡".repeat(38), "text-too-long"],
  ["group refused", "262", "hi", "dst-not-allowed"],
  ["emergency group refused", "9", "hi", "dst-not-allowed"],
  ["broadcast refused", "*", "hi", "dst-not-allowed"],
  ["not a callsign", "not a call", "hi", "bad-dst"],
  ["only control characters", "OE8APR-12", "\u0000\r\n", "empty-text"],
];

export function runMeshcomConformance(fixtures: MeshcomFixture[]): ConformanceResult {
  const failures: string[] = [];
  const outputs: Record<string, unknown> = {};

  for (const f of fixtures) {
    const input = f.datagramHex !== undefined ? hexBytes(f.datagramHex) : new TextEncoder().encode(f.datagram ?? "");
    const actual = view(input, f.receiver);
    outputs[f.name] = actual;
    for (const [k, want] of Object.entries(f.expect)) {
      if (!matches(actual, k, want))
        failures.push(`${f.name}: ${k} expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[k])}`);
    }
  }

  for (const [label, dst, text, want] of ENCODE_CASES) {
    const r = encodeMeshcomText(dst, text);
    const got = r.ok ? true : r.reason;
    outputs[`encode:${label}`] = r;
    if (got !== want) failures.push(`encode ${label}: expected ${String(want)}, got ${String(got)}`);
  }
  const enc = encodeMeshcomText("oe8apr-12", "Grüße\taus Kärnten");
  if (!enc.ok || enc.datagram !== '{"type":"msg","dst":"OE8APR-12","msg":"Grüße aus Kärnten"}')
    failures.push(`encode datagram shape: ${JSON.stringify(enc)}`);

  // Dedup: a server copy, then the LoRa copy of the same frame, then a repeat.
  const frame = (srcType: string, src: string) =>
    JSON.stringify({ src_type: srcType, type: "msg", src, dst: "OE8APR-12", msg: "x", msg_id: "0000ABCD" });
  const dd = new MeshcomDedup();
  const verdicts = [
    frame("udp", "DH1FR-1"),
    frame("lora", "DH1FR-1,OE1XOR-12"),
    frame("lora", "DH1FR-1"),
    frame("udp", "DH1FR-1"),
  ].map((d) => {
    const r = decodeMeshcom(d);
    return r.ok ? dd.offer(r.event, 1000) : "rejected";
  });
  outputs.dedup = verdicts;
  if (JSON.stringify(verdicts) !== JSON.stringify(["new", "upgrade", "upgrade", "duplicate"]))
    failures.push(`dedup verdicts: ${JSON.stringify(verdicts)}`);

  return { failures, outputs };
}
