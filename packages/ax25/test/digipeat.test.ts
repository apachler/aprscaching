import { describe, it, expect } from "vitest";
import { digipeatAx25 } from "../src/digipeat.js";
import { frameContentKey, ViscousDigi } from "../src/digipeat.js";
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

describe("viscous-digi bookkeeping (docs/29 F3)", () => {
  it("content key ignores the via path so a re-digied copy matches the original", () => {
    const a = frameContentKey(base([A("OE8DGI"), A("OE9OTH")]));                     // fresh
    const b = frameContentKey(base([A("OE8DGI"), A("OE9OTH")], [true, false]));      // our hop now repeated
    const c = frameContentKey(base([A("RELAY")]));                                   // different via path
    expect(a).toBe(b);                                                                // same frame, later stage → same key
    expect(a).toBe(c);                                                                // via path excluded entirely
    // a different frame (poll bit set) does not collide
    expect(a).not.toBe(frameContentKey({ ...base([]), pf: false }));
  });

  it("cancels a pending repeat when a duplicate is heard, then not again", () => {
    const v = new ViscousDigi<number>();
    v.schedule("k", 42);
    expect(v.pendingCount()).toBe(1);
    expect(v.onDuplicate("k")).toBe(42);        // heard again → cancel token returned
    expect(v.onDuplicate("k")).toBeNull();      // already cancelled
    expect(v.pendingCount()).toBe(0);
  });

  it("a fired repeat is no longer cancellable (our own TX echo is ignored)", () => {
    const v = new ViscousDigi<number>();
    v.schedule("k", 7);
    v.fired("k");
    expect(v.onDuplicate("k")).toBeNull();
  });
});
