import { describe, it, expect } from "vitest";
import { deframeMeshtastic, parseMeshtasticProto } from "../src/index.js";

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
