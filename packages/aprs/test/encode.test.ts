import { describe, it, expect } from "vitest";
import { encodeAprsPosition, encodeAprsMessage, decodeAprs, encodeAx25, kissWrap, kissFrames, decodeAx25 } from "../src/index.js";

const decode = (payload: string) => decodeAprs({ src: "OE8APR-9", dst: "APRS", path: [], payload, raw: "" });

describe("APRS encoders (docs/16 H5 originating traffic)", () => {
  it("encodes a position that round-trips through the decoder", () => {
    const info = encodeAprsPosition(47.0735, 15.4378, "/>", "on the air");
    expect(info.startsWith("!4704.41N/")).toBe(true);
    const d = decode(info) as { kind: string; lat: number; lon: number; comment?: string };
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(47.0735, 3);
    expect(d.lon).toBeCloseTo(15.4378, 3);
    expect(d.comment).toContain("on the air");
  });

  it("handles southern/western hemispheres", () => {
    const d = decode(encodeAprsPosition(-33.87, -70.5, "/>")) as { lat: number; lon: number };
    expect(d.lat).toBeCloseTo(-33.87, 2);
    expect(d.lon).toBeCloseTo(-70.5, 2);
  });

  it("encodes a message with a 9-char addressee that decodes back", () => {
    const info = encodeAprsMessage("oe3abc", "hello world", "7");
    expect(info).toBe(":OE3ABC   :hello world{7");
    const d = decode(info) as { kind: string; addressee: string; text: string; msgNo?: string };
    expect(d.kind).toBe("message");
    expect(d.addressee).toBe("OE3ABC");
    expect(d.text).toBe("hello world");
  });

  it("strips reserved/control characters from message text", () => {
    expect(encodeAprsMessage("X", "a|b~c{d\ne")).toBe(":X        :abcde");
  });

  it("frames an encoded position through AX.25 + KISS for TX (the browser send path)", () => {
    const frame = { src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1"], payload: encodeAprsPosition(47.07, 15.42, "/>") };
    const back = decodeAx25(kissFrames(kissWrap(encodeAx25(frame)))[0]!)!;
    expect(back.src).toBe("OE8APR-9");
    expect((decodeAprs(back) as { kind: string }).kind).toBe("position");
  });
});
