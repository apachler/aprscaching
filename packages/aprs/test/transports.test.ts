// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  encodeAx25,
  decodeAx25,
  kissWrap,
  kissFrames,
  parseCot,
  splitCotEvents,
  parseMeshtasticJson,
  formatPosition,
  decodeAprs,
} from "../src/index.js";

describe("AX.25 + KISS", () => {
  it("round-trips a UI frame through encode/decode", () => {
    const f = { src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1", "WIDE2-1"], payload: "!4704.41N/01526.27E>hi" };
    const d = decodeAx25(encodeAx25(f))!;
    expect(d.src).toBe("OE8APR-9");
    expect(d.dst).toBe("APRS");
    expect(d.path).toEqual(["WIDE1-1", "WIDE2-1"]);
    expect(d.payload).toBe("!4704.41N/01526.27E>hi");
  });
  it("preserves a has-been-repeated digipeater mark", () => {
    const d = decodeAx25(encodeAx25({ src: "N0CALL", dst: "APRS", path: ["OE8XXX*"], payload: ">test" }))!;
    expect(d.path).toEqual(["OE8XXX*"]);
  });
  it("survives KISS wrap/unwrap with escaping", () => {
    const ax = encodeAx25({ src: "OE8APR", dst: "APRS", path: [], payload: "data\xc0\xdb edge" });
    const frames = kissFrames(kissWrap(ax));
    expect(frames.length).toBe(1);
    const d = decodeAx25(frames[0]!)!;
    expect(d.src).toBe("OE8APR");
    expect(d.payload).toBe("data\xc0\xdb edge");
  });
  it("rejects a non-UI frame", () => {
    const ax = encodeAx25({ src: "A", dst: "B", path: [], payload: "x" });
    ax[14] = 0x00; // clobber the control byte (UI = 0x03)
    expect(decodeAx25(ax)).toBeNull();
  });
});

describe("CoT inbound", () => {
  const ev = `<event version="2.0" uid="APRS.OE8APR-9" type="a-f-G-E-V-C"><point lat="47.0735" lon="15.4378" hae="376.0" ce="9999999" le="9999999"/><detail><contact callsign="OE8APR-9"/><track course="88" speed="18.52"/><remarks>APRS /&gt; Mobile</remarks></detail></event>`;
  it("parses a CoT event into a fix", () => {
    const f = parseCot(ev)!;
    expect(f.callsign).toBe("OE8APR-9");
    expect(f.lat).toBeCloseTo(47.0735, 4);
    expect(f.lon).toBeCloseTo(15.4378, 4);
    expect(f.altitudeM).toBe(376);
    expect(f.course).toBe(88);
    expect(f.speedKn).toBe(36); // 18.52 m/s -> ~36 kn
    expect(f.comment).toBe("APRS /> Mobile");
  });
  it("splits a multi-event document", () => {
    expect(splitCotEvents(ev + ev).length).toBe(2);
  });
  it("ignores a null-island point", () => {
    expect(parseCot(`<event><point lat="0" lon="0"/></event>`)).toBeNull();
  });
});

describe("formatPosition (CoT/Meshtastic normalisation)", () => {
  it("round-trips through the decoder", () => {
    const payload = formatPosition(47.0735, 15.4378, {
      code: ">",
      course: 88,
      speedKn: 36,
      altitudeM: 376,
      comment: " test",
    });
    const d = decodeAprs({ src: "X", dst: "APRS", path: [], payload, raw: "" }) as any;
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(47.0735, 3);
    expect(d.lon).toBeCloseTo(15.4378, 3);
    expect(d.course).toBe(88);
    expect(d.speedKn).toBe(36);
    expect(d.altitudeM).toBeCloseTo(376, 0);
  });
});

describe("Meshtastic JSON", () => {
  it("parses a position envelope", () => {
    const f = parseMeshtasticJson(
      `{"from":305419896,"sender":"!1234abcd","type":"position","payload":{"latitude_i":470735000,"longitude_i":154378000,"altitude":376}}`,
    )!;
    expect(f.node).toBe("!1234abcd");
    expect(f.lat).toBeCloseTo(47.0735, 4);
    expect(f.lon).toBeCloseTo(15.4378, 4);
    expect(f.altitudeM).toBe(376);
  });
  it("ignores non-position envelopes", () => {
    expect(parseMeshtasticJson(`{"type":"nodeinfo","payload":{}}`)).toBeNull();
  });
});
