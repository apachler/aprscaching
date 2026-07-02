import { describe, it, expect } from "vitest";
import { deframeMeshtastic, parseMeshtasticProto, parseMeshPacket, parseMeshServiceEnvelope } from "../src/index.js";

// --- tiny protobuf builder (mirrors the canonical Meshtastic field numbers) ---
const u8 = (...a: number[]) => Uint8Array.from(a);
function varintBytes(n: number): number[] { const o: number[] = []; let v = n >>> 0; while (v > 0x7f) { o.push((v & 0x7f) | 0x80); v >>>= 7; } o.push(v); return o; }
const tag = (f: number, w: number) => varintBytes((f << 3) | w);
function sfix32(n: number): number[] { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return [...b]; }
const lenDelim = (f: number, bytes: number[]) => [...tag(f, 2), ...varintBytes(bytes.length), ...bytes];
const fixed32 = (f: number, n: number) => [...tag(f, 5), ...sfix32(n)];
const vfield = (f: number, n: number) => [...tag(f, 0), ...varintBytes(n)];

function fromRadioPosition(lat: number, lon: number, alt: number, from: number, portnum = 3): number[] {
  const pos = [...fixed32(1, Math.round(lat * 1e7)), ...fixed32(2, Math.round(lon * 1e7)), ...vfield(3, alt)];
  const data = [...vfield(1, portnum), ...lenDelim(2, pos)];
  const packet = [...fixed32(1, from), ...lenDelim(4, data)];
  return lenDelim(2, packet);                 // FromRadio.packet = field 2
}
const frame = (body: number[]) => u8(0x94, 0xc3, (body.length >> 8) & 0xff, body.length & 0xff, ...body);

describe("meshtastic — browser-direct serial frames (docs/16 H3)", () => {
  it("deframes 0x94/0xC3-headed frames and leaves an incomplete tail in `rest`", () => {
    const a = fromRadioPosition(47.0735, 15.4378, 350, 0x12345678);
    const b = fromRadioPosition(48, 16, 0, 0x000000ff);
    const fa = frame(a), fb = frame(b);
    const stream = u8(0x00, 0x11, ...fa, ...fb.subarray(0, 3)); // junk + full + partial
    const { frames, rest } = deframeMeshtastic(stream);
    expect(frames).toHaveLength(1);                 // only the complete one
    expect(rest.length).toBe(3);                    // partial second frame held back
  });

  it("parses a POSITION_APP frame into a node fix (lat/lon ×1e-7, !hex node id)", () => {
    const { frames } = deframeMeshtastic(frame(fromRadioPosition(47.0735, 15.4378, 350, 0xdeadbeef)));
    const fix = parseMeshtasticProto(frames[0]!)!;
    expect(fix.node).toBe("!deadbeef");
    expect(fix.lat).toBeCloseTo(47.0735, 4);
    expect(fix.lon).toBeCloseTo(15.4378, 4);
    expect(fix.altitudeM).toBe(350);
  });

  it("ignores non-position ports and 0/0 fixes", () => {
    const { frames: f1 } = deframeMeshtastic(frame(fromRadioPosition(47, 15, 0, 1, 1))); // portnum 1 = TEXT
    expect(parseMeshtasticProto(f1[0]!)).toBeNull();
    const { frames: f2 } = deframeMeshtastic(frame(fromRadioPosition(0, 0, 0, 1)));
    expect(parseMeshtasticProto(f2[0]!)).toBeNull();
  });
});

// --- native MQTT protobuf ServiceEnvelope + typed events (docs/16 Path A) ---
const str = (s: string) => [...new TextEncoder().encode(s)];
/** Build a MeshPacket body (from + decoded Data{portnum, payload}). */
function meshPacket(from: number, portnum: number, payload: number[]): number[] {
  const data = [...vfield(1, portnum), ...lenDelim(2, payload)];
  return [...fixed32(1, from), ...lenDelim(4, data)];
}
/** Wrap a MeshPacket in a ServiceEnvelope (packet = field 1) — the MQTT protobuf shape. */
const serviceEnvelope = (packet: number[]) => u8(...lenDelim(1, packet), ...lenDelim(2, str("LongFast")), ...lenDelim(3, str("!gw000001")));

describe("meshtastic — native MQTT ServiceEnvelope + typed events (docs/16 Path A)", () => {
  it("decodes a POSITION packet from a ServiceEnvelope", () => {
    const pos = [...fixed32(1, Math.round(47.05 * 1e7)), ...fixed32(2, Math.round(15.44 * 1e7)), ...vfield(3, 400)];
    const ev = parseMeshServiceEnvelope(serviceEnvelope(meshPacket(0xdeadbeef, 3, pos)));
    expect(ev?.kind).toBe("position");
    if (ev?.kind === "position") { expect(ev.fix.node).toBe("!deadbeef"); expect(ev.fix.lat).toBeCloseTo(47.05, 4); expect(ev.fix.altitudeM).toBe(400); }
  });

  it("decodes a TEXT_MESSAGE_APP packet", () => {
    const ev = parseMeshPacket(u8(...meshPacket(0x0000abcd, 1, str("hi from mesh"))));
    expect(ev).toEqual({ kind: "text", node: "!0000abcd", text: "hi from mesh" });
  });

  it("decodes a NODEINFO_APP (User) packet into long/short names", () => {
    const user = [...lenDelim(1, str("!0000abcd")), ...lenDelim(2, str("Base Camp")), ...lenDelim(3, str("BC"))];
    const ev = parseMeshPacket(u8(...meshPacket(0x0000abcd, 4, user)));
    expect(ev).toEqual({ kind: "nodeinfo", node: "!0000abcd", longName: "Base Camp", shortName: "BC" });
  });

  it("returns null for an encrypted packet (no decoded Data)", () => {
    const encrypted = [...fixed32(1, 0x11223344), ...lenDelim(8, [1, 2, 3, 4])]; // field 8 = encrypted
    expect(parseMeshPacket(u8(...encrypted))).toBeNull();
  });
});
