import { describe, it, expect } from "vitest";
import { digipeatAx25 } from "../src/digipeat.js";
import { encodeFrame, decodeFrame, type Ax25Frame } from "../src/frame.js";

const A = (call: string, ssid = 0) => ({ call, ssid });
const base = (digis: ReturnType<typeof A>[], digisRepeated?: boolean[]): Ax25Frame =>
  ({ dst: A("OE8NOD", 1), src: A("OE1SND"), digis, digisRepeated, command: true, type: "SABM", pf: true });

describe("connected-mode AX.25 digipeat (docs/29 F3)", () => {
  it("repeats a frame whose next via-hop is us and sets the H-bit", () => {
    const f = base([A("OE8DGI"), A("OE9OTH")]);
    const out = digipeatAx25(f, [A("OE8DGI")]);
    expect(out).not.toBeNull();
    expect(out!.digisRepeated).toEqual([true, false]);   // our hop consumed, the next still pending
    expect(out!.type).toBe("SABM");                       // any frame type, not just UI
  });

  it("matches an alias as well as the station call", () => {
    const f = base([A("RELAY")]);
    expect(digipeatAx25(f, [A("OE8DGI"), A("RELAY")])).not.toBeNull();
  });

  it("ignores a frame whose next un-repeated hop is not us", () => {
    expect(digipeatAx25(base([A("OE9OTH")]), [A("OE8DGI")])).toBeNull();
  });

  it("ignores an already-consumed hop (only the FIRST un-repeated hop counts)", () => {
    // our call is hop 0 but already repeated; the next pending hop is someone else → not ours
    const f = base([A("OE8DGI"), A("OE9OTH")], [true, false]);
    expect(digipeatAx25(f, [A("OE8DGI")])).toBeNull();
  });

  it("returns null when there is no via path or all hops are repeated", () => {
    expect(digipeatAx25(base([]), [A("OE8DGI")])).toBeNull();
    expect(digipeatAx25(base([A("OE8DGI")], [true]), [A("OE8DGI")])).toBeNull();
  });

  it("round-trips the H-bit through encode/decode so downstream nodes see it consumed", () => {
    const out = digipeatAx25(base([A("OE8DGI"), A("OE9OTH")]), [A("OE8DGI")])!;
    const wire = decodeFrame(encodeFrame(out))!;
    expect(wire.digisRepeated).toEqual([true, false]);
    expect(wire.digis!.map((d) => d.call)).toEqual(["OE8DGI", "OE9OTH"]);
  });
});
