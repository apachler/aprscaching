// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { encodeAprsPosition, encodeAprsMessage, encodeAprsWeather, decodeAprs, encodeAx25, kissWrap, kissFrames, decodeAx25 } from "../src/index.js";

const decode = (payload: string) => decodeAprs({ src: "OE8APR-9", dst: "APRS", path: [], payload, raw: "" });

describe("APRS encoders (docs/design/16 H5 originating traffic)", () => {
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

  it("encodes a weather report in APRS wire units that round-trips through the decoder (docs/design/17 W2)", () => {
    // 20 °C, 55 %, 1013.2 hPa, wind 180° @ ~8.7 kn (10 mph), gust ~13 kn (15 mph), 2.54 mm/h rain
    const info = encodeAprsWeather(47.0735, 15.4378, {
      tempC: 20, humidity: 55, pressureHpa: 1013.2, windDirDeg: 180,
      windKn: 10 / 1.15078, gustKn: 15 / 1.15078, rainMm: 2.54,
    });
    expect(info.startsWith("!4704.41N/01526.27E_180/010g015t068")).toBe(true); // 20°C = 68°F
    expect(info).toContain("h55");        // humidity verbatim
    expect(info).toContain("b10132");     // 1013.2 hPa → tenths
    expect(info).toContain("r010");       // 2.54 mm = 0.10 in = 10 hundredths
    const d = decode(info) as { kind: string; lat: number; tempC: number; humidity: number; pressureHpa: number; windDirDeg: number };
    expect(d.kind).toBe("weather");
    expect(d.tempC).toBeCloseTo(20, 0);
    expect(d.humidity).toBe(55);
    expect(d.pressureHpa).toBeCloseTo(1013.2, 0);
    expect(d.windDirDeg).toBe(180);
  });

  it("uses placeholders for unknown wind/temp and encodes 100% humidity + negative temp", () => {
    const a = encodeAprsWeather(0, 0, {});
    expect(a).toContain("_.../...g...t...");           // all-unknown core fields
    const b = encodeAprsWeather(0, 0, { tempC: -20, humidity: 100 });
    expect(b).toContain("t-04");                        // -20 °C = -4 °F → "-04"
    expect(b).toContain("h00");                         // 100% encodes as 00
  });

  it("frames an encoded position through AX.25 + KISS for TX (the browser send path)", () => {
    const frame = { src: "OE8APR-9", dst: "APRS", path: ["WIDE1-1"], payload: encodeAprsPosition(47.07, 15.42, "/>") };
    const back = decodeAx25(kissFrames(kissWrap(encodeAx25(frame)))[0]!)!;
    expect(back.src).toBe("OE8APR-9");
    expect((decodeAprs(back) as { kind: string }).kind).toBe("position");
  });
});
