// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decodeAprs, parseCompressed, decodeMicE, lookupSymbol, encodeAprsWeather } from "../src/index.js";
import type { ParsedFrame } from "../src/index.js";

const frame = (payload: string, dst = "APRS"): ParsedFrame => ({ src: "TEST", dst, path: [], payload, raw: "" });

describe("uncompressed position", () => {
  it("decodes lat/lon + symbol + course/speed + altitude", () => {
    const d = decodeAprs(frame("!4903.50N/07201.75W>088/036/A=001234Going home")) as any;
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(49.0583, 3);
    expect(d.lon).toBeCloseTo(-72.0292, 3);
    expect(d.symbol.label).toBe("Car");
    expect(d.course).toBe(88);
    expect(d.speedKn).toBe(36);
    expect(d.altitudeM).toBe(Math.round(1234 * 0.3048));
    expect(d.comment).toBe("Going home");
  });
  it("strips a timestamp for @ reports", () => {
    const d = decodeAprs(frame("@092345z4903.50N/07201.75W>test")) as any;
    expect(d.kind).toBe("position");
    expect(d.timestamp).toBe("092345z");
    expect(d.lat).toBeCloseTo(49.0583, 3);
  });
});

describe("compressed position (base-91)", () => {
  it("decodes the APRS101 worked example (49.5N, 72.75W)", () => {
    const c = parseCompressed("/5L!!<*e7> sT")!;
    expect(c.lat).toBeCloseTo(49.5, 3);
    expect(c.lon).toBeCloseTo(-72.75, 2);
  });
  it("decodes compressed course/speed", () => {
    const c = parseCompressed("/5L!!<*e7>7P[")!;
    expect(c.course).toBe(88);
    expect(c.speedKn).toBeCloseTo(36.2, 1);
  });
  it("routes through decodeAprs", () => {
    const d = decodeAprs(frame("=/5L!!<*e7> sT")) as any;
    expect(d.kind).toBe("position");
    expect(d.lat).toBeCloseTo(49.5, 3);
  });
});

describe("MIC-E", () => {
  // dest "SSRUVT" -> 33 deg 25.64' N, +100 lon offset, West
  // info: ` ( $ n \x1e \x1e O > /  -> lon 112 deg 08.82' W, course 251, speed 20, car symbol
  const info = "`($n\x1e\x1eO>/";
  it("decodes latitude from the destination address", () => {
    const m = decodeMicE("SSRUVT", info)!;
    expect(m.lat).toBeCloseTo(33.4273, 3);
  });
  it("decodes longitude, course, speed, symbol, message", () => {
    const m = decodeMicE("SSRUVT", info)!;
    expect(m.lon).toBeCloseTo(-112.147, 3);
    expect(m.course).toBe(251);
    expect(m.speedKn).toBe(20);
    expect(m.code).toBe(">");
    expect(m.messageType).toBe("Off Duty");
  });
  it("routes through decodeAprs as a position", () => {
    const d = decodeAprs(frame(info, "SSRUVT")) as any;
    expect(d.kind).toBe("position");
    expect(d.symbol.label).toBe("Car");
    expect(d.lat).toBeCloseTo(33.4273, 3);
  });
});

describe("weather", () => {
  it("decodes a positionful weather report", () => {
    const d = decodeAprs(frame("@092345z4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900")) as any;
    expect(d.kind).toBe("weather");
    expect(d.windDirDeg).toBe(220);
    expect(d.windKn).toBe(3.5); // 4 mph: APRS weather reports wind and gust in mph
    expect(d.gustKn).toBe(4.3); // 5 mph
    expect(d.tempC).toBeCloseTo(25, 0);
    expect(d.humidity).toBe(50);
    expect(d.pressureHpa).toBeCloseTo(990, 0);
  });
  it("decodes a positionless report with the c…s… wind fields (the spec's example)", () => {
    const d = decodeAprs(frame("_10090556c220s004g005t077r000p000P000h50b09900wRSW")) as any;
    expect(d).toMatchObject({ kind: "weather", windDirDeg: 220, windKn: 3.5, gustKn: 4.3, humidity: 50 });
    expect(d.tempC).toBeCloseTo(25, 0);
  });
  it("reads dots or spaces as unknown, and still decodes the report", () => {
    const d = decodeAprs(frame("!4903.50N/07201.75W_.../...g...t050")) as any;
    expect(d.kind).toBe("weather");
    expect(d.windDirDeg).toBeUndefined();
    expect(d.windKn).toBeUndefined();
    expect(d.gustKn).toBeUndefined();
    expect(d.tempC).toBe(10);
  });
  it("decodes its own weather beacon back", () => {
    const d = decodeAprs(frame(encodeAprsWeather(49, 7, { windKn: 10, gustKn: 20, tempC: 20 }))) as any;
    expect(d).toMatchObject({ kind: "weather", tempC: 20 });
    // the report carries whole mph, so a speed comes back within half an mph
    expect(Math.abs(d.windKn - 10)).toBeLessThan(0.5);
    expect(Math.abs(d.gustKn - 20)).toBeLessThan(0.5);
  });
  it("decodes a compressed weather report, wind from the course and speed", () => {
    const d = decodeAprs(frame("@092345z/5L!!<*e7_7P[g005t077r000p000P000h50b09900wRSW")) as any;
    expect(d).toMatchObject({ kind: "weather", windDirDeg: 88, gustKn: 4.3, humidity: 50 });
    expect(d.windKn).toBeCloseTo(36.2, 1);
  });
  it("reads no temperature from a 't' in the comment after an unknown one", () => {
    const d = decodeAprs(frame("!4903.50N/07201.75W_220/004g005t...h50b09900 temp sensor t123")) as any;
    expect(d.tempC).toBeUndefined();
    expect(d.humidity).toBe(50);
  });
});

describe("objects per APRS 1.2", () => {
  it("keeps an object's position and weather when its symbol is the weather station", () => {
    const d = decodeAprs(frame(";BRENDA   *092345z4903.50N/07201.75W_220/004g005b0990")) as any;
    expect(d).toMatchObject({ kind: "object", name: "BRENDA", alive: true, windDirDeg: 220, timestamp: "092345z" });
    expect(d.lat).toBeCloseTo(49.0583, 3);
  });
  it("decodes an object sent without its timestamp at the right position", () => {
    const d = decodeAprs(frame(";BRENDA   *4903.50N/07201.75W>moving")) as any;
    expect(d.lat).toBeCloseTo(49.0583, 3);
    expect(d.lon).toBeCloseTo(-72.0292, 3);
  });
  it("takes only '*' or '_' after the name, and keeps leading spaces in it", () => {
    expect(decodeAprs(frame(";LEADER   X092345z4903.50N/07201.75W>x")).kind).toBe("other");
    expect(decodeAprs(frame(";LEADER   _092345z4903.50N/07201.75W>x"))).toMatchObject({ alive: false });
    expect(decodeAprs(frame("; LEAD    *092345z4903.50N/07201.75W>x"))).toMatchObject({ name: " LEAD" });
  });
});

describe("objects, items, messages, status, telemetry", () => {
  it("decodes a live object", () => {
    const d = decodeAprs(frame(";LEADER   *092345z4903.50N/07201.75W>test")) as any;
    expect(d.kind).toBe("object");
    expect(d.name).toBe("LEADER");
    expect(d.alive).toBe(true);
    expect(d.lat).toBeCloseTo(49.0583, 3);
  });
  it("decodes an item", () => {
    const d = decodeAprs(frame(")Gateway!4903.50N/07201.75W#radio")) as any;
    expect(d.kind).toBe("item");
    expect(d.name).toBe("Gateway");
    expect(d.alive).toBe(true);
  });
  it("decodes a message with a number", () => {
    const d = decodeAprs(frame(":OE8APR   :Hello world{001")) as any;
    expect(d.kind).toBe("message");
    expect(d.addressee).toBe("OE8APR");
    expect(d.text).toBe("Hello world");
    expect(d.msgNo).toBe("001");
  });
  it("decodes an ack", () => {
    const d = decodeAprs(frame(":OE8APR   :ack007")) as any;
    expect(d.ack).toBe(true);
    expect(d.msgNo).toBe("007");
  });
  it("flags a bulletin", () => {
    const d = decodeAprs(frame(":BLN1     :Net tonight 8pm")) as any;
    expect(d.bulletin).toBe("BLN1");
  });
  it("decodes a status report", () => {
    const d = decodeAprs(frame(">Net control online")) as any;
    expect(d.kind).toBe("status");
    expect(d.text).toBe("Net control online");
  });
  it("decodes telemetry", () => {
    const d = decodeAprs(frame("T#123,007,008,009,010,011,01100000")) as any;
    expect(d.kind).toBe("telemetry");
    expect(d.seq).toBe(123);
    expect(d.analog).toEqual([7, 8, 9, 10, 11]);
    expect(d.digital).toEqual([false, true, true, false, false, false, false, false]);
  });
});

describe("symbol catalog", () => {
  it("labels primary + alternate", () => {
    expect(lookupSymbol("/", ">").label).toBe("Car");
    expect(lookupSymbol("/", "_").category).toBe("weather");
    expect(lookupSymbol("T", "#").overlay).toBe("T"); // overlay digi
  });
});
