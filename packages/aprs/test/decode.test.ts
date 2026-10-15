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

describe("positions per APRS 1.2", () => {
  it("takes the ambiguity from the latitude and drops the same digits from the longitude", () => {
    const one = decodeAprs(frame("!4903.  N/07201.75W-")) as any;
    expect(one.ambiguity).toBe(2);
    expect(one.lon).toBeCloseTo(-72.016667, 5); // 072°01', not 072°01.75'
    expect((decodeAprs(frame("!4903.  N/07201.  W-")) as any).ambiguity).toBe(2);
    expect((decodeAprs(frame("!49  .  N/072  .  W-")) as any).ambiguity).toBe(4);
  });
  it("reads course 000 and 000/000 as unknown", () => {
    const d = decodeAprs(frame("!4903.50N/07201.75W>000/000")) as any;
    expect(d.course).toBeUndefined();
    expect(d.speedKn).toBeUndefined();
    const parked = decodeAprs(frame("!4903.50N/07201.75W>000/005")) as any;
    expect(parked.course).toBeUndefined();
    expect(parked.speedKn).toBe(5);
    expect((decodeAprs(frame("!4903.50N/07201.75W>360/010")) as any).course).toBe(360);
  });
  it("takes .../... and blanks as an unknown course and speed, not as the comment", () => {
    for (const cse of [".../...", "   /   "]) {
      const d = decodeAprs(frame(`!4903.50N/07201.75W>${cse}Test`)) as any;
      expect(d.comment).toBe("Test");
      expect(d.course).toBeUndefined();
    }
  });
  it("never reads a compressed position's comment as its course and speed", () => {
    const d = decodeAprs(frame("!/5L!!<*e7>7P[123/456 hi")) as any;
    expect(d.course).toBe(88);
    expect(d.speedKn).toBeCloseTo(36.2, 1);
    expect(d.comment).toBe("123/456 hi");
  });
  it("passes on a compressed radio range", () => {
    expect((decodeAprs(frame("=/5L!!<*e7>{?!")) as any).rangeKm).toBe(32.4);
  });
});

describe("MIC-E per APRS 1.2", () => {
  const base = '`(_fn"Oj/';
  it("reads the altitude after a device prefix, and drops prefix and suffix from the comment", () => {
    const d710 = decodeMicE("S32U6T", `${base}]"4T}Mobile=`)!;
    expect(d710.altitudeM).toBe(61);
    expect(d710.comment).toBe("Mobile");
    expect(decodeMicE("S32U6T", `${base}>"4T}^`)!).toMatchObject({ altitudeM: 61 });
    expect(decodeMicE("S32U6T", `${base}>"4T}^`)!.comment).toBeUndefined();
    const ft3d = decodeMicE("S32U6T", `${base}\`"4T}Hiking_0`)!;
    expect(ft3d).toMatchObject({ altitudeM: 61, comment: "Hiking" });
    expect(decodeMicE("S32U6T", `${base}"4T}`)!.altitudeM).toBe(61); // no prefix, as before
  });
  it("applies the latitude's ambiguity to the longitude", () => {
    // T4SQZZ: the last two latitude digits ambiguous, so the longitude is 112°07', not 112°07.74'
    const m = decodeMicE("T4SQZZ", base)!;
    expect(m.ambiguity).toBe(2);
    expect(m.lon).toBeCloseTo(-112.116667, 5);
  });
  it("reads course 0 as unknown and 360 as north", () => {
    expect(decodeMicE("S32U6T", "`(_fl\x1c\x1cj/")!.course).toBeUndefined();
  });
  it("calls a mix of Standard and Custom message bits Unknown, and refuses A-K after the third byte", () => {
    expect(decodeMicE("S2DU6T", base)!.messageType).toBe("Unknown");
    expect(decodeMicE("S32UKT", base)).toBeNull();
    expect(decodeMicE("S32U6T", base)!.messageType).toBe("Returning");
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

describe("telemetry, status and third-party per APRS 1.2", () => {
  it("reads the MIC sequence of a Mic-E unit, with or without a comma", () => {
    for (const p of ["T#MIC199,000,255,073,123,01101001", "T#MIC,199,000,255,073,123,01101001"]) {
      const d = decodeAprs(frame(p)) as any;
      expect(d.seq).toBeUndefined();
      expect(d.analog).toEqual([199, 0, 255, 73, 123]);
      expect(d.digital).toEqual([false, true, true, false, true, false, false, true]);
    }
  });
  it("takes a leading DDHHMMz timestamp out of the status text", () => {
    expect(decodeAprs(frame(">092345zNet Control Center"))).toEqual({
      kind: "status",
      text: "Net Control Center",
      timestamp: "092345z",
    });
  });
  it("decodes the packet a third-party packet carries, under its own sender", () => {
    const d = decodeAprs(frame("}WB4APR-14>APRS,TCPIP,G9RXG*::G3NRW    :Hi Ian{001")) as any;
    expect(d.kind).toBe("thirdparty");
    expect(d.inner).toMatchObject({ src: "WB4APR-14", dst: "APRS", path: ["TCPIP", "G9RXG*"] });
    expect(d.data).toMatchObject({ kind: "message", addressee: "G3NRW", text: "Hi Ian", msgNo: "001" });
    const pos = decodeAprs(frame("}OE1ABC>APRS,TCPIP,OE8XXX*:!4903.50N/07201.75W>moving")) as any;
    expect(pos.data.kind).toBe("position");
  });
  it("decodes one level of third-party traffic and no deeper", () => {
    const d = decodeAprs(frame("}A>B:}C>D:!4903.50N/07201.75W>x")) as any;
    expect(d.data.kind).toBe("other");
    expect(decodeAprs(frame("}not a packet")).kind).toBe("other");
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
  it("reads a reply-ack message number: MM is the number, AA acks ours", () => {
    const d = decodeAprs(frame(":WU2Z     :Testing{AB}CD")) as any;
    expect(d).toMatchObject({ text: "Testing", msgNo: "AB", replyAck: "CD" });
    const open = decodeAprs(frame(":WU2Z     :Testing{AB}")) as any;
    expect(open).toMatchObject({ text: "Testing", msgNo: "AB" });
    expect(open.replyAck).toBeUndefined();
  });
  it("takes the acknowledged number out of an ack of a reply-ack number", () => {
    const d = decodeAprs(frame(":WU2Z     :ackAB}CD")) as any;
    expect(d).toMatchObject({ ack: true, msgNo: "AB", text: "" });
  });
  it("reads text that only starts with ack or rej as a message", () => {
    for (const text of ["acknowledged, thanks", "rejoice!"]) {
      const d = decodeAprs(frame(`:N0CALL   :${text}`)) as any;
      expect(d.ack ?? d.rej).toBeUndefined();
      expect(d.text).toBe(text);
    }
    const numbered = decodeAprs(frame(":N0CALL   :ack ok see you{12")) as any;
    expect(numbered).toMatchObject({ text: "ack ok see you", msgNo: "12" });
    expect(numbered.ack).toBeUndefined();
  });
  it("decodes a rej", () => {
    expect(decodeAprs(frame(":OE8APR   :rej003"))).toMatchObject({ rej: true, msgNo: "003" });
  });
  it("takes no message number longer than five characters", () => {
    const d = decodeAprs(frame(":WU2Z     :Hi{1234567")) as any;
    expect(d.msgNo).toBeUndefined();
    expect(d.text).toBe("Hi{1234567");
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

describe("data extensions per APRS 1.2 chapter 7", () => {
  const d = (payload: string) => decodeAprs(frame(payload)) as any;

  it("decodes PHG5132: 25 W, 20 ft, 3 dB, east, and its range of about 7.9 miles", () => {
    const p = d("=4903.50N/07201.75W#PHG5132");
    expect(p.kind).toBe("position");
    expect(p.phg).toEqual({ powerW: 25, heightM: 6.1, gainDb: 3, directivityDeg: 90 });
    expect(p.rangeKm).toBe(12.8);
    expect(p.comment).toBeUndefined();
  });

  it("leaves the directivity out for an omni antenna and keeps the comment after the extension", () => {
    const p = d("!4903.50N/07201.75W#PHG2360 Digi on the hill");
    expect(p.phg).toEqual({ powerW: 4, heightM: 24.4, gainDb: 6 });
    expect(p.rangeKm).toBe(19.2);
    expect(p.comment).toBe("Digi on the hill");
  });

  it("maps directivity codes 1–8 to 45°–360°", () => {
    for (let code = 1; code <= 8; code++)
      expect(d(`!4903.50N/07201.75W#PHG513${code}`).phg.directivityDeg).toBe(code * 45);
  });

  it("reads height codes past 9 for balloons and aircraft", () => {
    expect(d("!4903.50N/07201.75WOPHG5:30").phg.heightM).toBe(3121.2); // 10240 ft
    expect(d("!4903.50N/07201.75WOPHG5;30").phg.heightM).toBe(Math.round(20480 * 0.3048 * 10) / 10);
  });

  it("reads the PHGR probe form's beacon rate and the mandatory slash", () => {
    expect(d("!4903.50N/07201.75W#PHG72604/ probe")).toMatchObject({
      phg: { powerW: 49, heightM: 12.2, gainDb: 6, beaconsPerHour: 4 },
      comment: "probe",
    });
    expect(d("!4903.50N/07201.75W#PHG7260A/").phg.beaconsPerHour).toBe(10);
    expect(d("!4903.50N/07201.75W#PHG7260Z/").phg.beaconsPerHour).toBe(35);
    // a rate character without its slash is the comment, not a rate
    const noSlash = d("!4903.50N/07201.75W#PHG72604 x");
    expect(noSlash.phg.beaconsPerHour).toBeUndefined();
    expect(noSlash.comment).toBe("4 x");
  });

  it("keeps an altitude after the PHG", () => {
    const p = d("!4703.50N/01524.00E-PHG2360/A=001234 home");
    expect(p.phg).toMatchObject({ powerW: 4 });
    expect(p.altitudeM).toBe(Math.round(1234 * 0.3048));
    expect(p.comment).toBe("home");
  });

  it("leaves a malformed PHG in the comment", () => {
    for (const bad of ["PHG513", "PHGx132", "PHG5139", "PHG51x2", "phg5132"]) {
      const p = d(`!4903.50N/07201.75W#${bad} rest`);
      expect(p.phg).toBeUndefined();
      expect(p.rangeKm).toBeUndefined();
      expect(p.comment).toBe(`${bad} rest`);
    }
  });

  it("reads PHG only where the data extension sits, right after the position", () => {
    const p = d("!4903.50N/07201.75W#Digi PHG5132");
    expect(p.phg).toBeUndefined();
    expect(p.comment).toBe("Digi PHG5132");
  });

  it("decodes RNG0050 as a range of 50 miles", () => {
    const p = d("@092345z4903.50N/07201.75W>RNG0050 mobile");
    expect(p.rangeKm).toBe(80.5);
    expect(p.phg).toBeUndefined();
    expect(p.comment).toBe("mobile");
    expect(d("!4903.50N/07201.75W>RNG005 x").rangeKm).toBeUndefined();
  });

  it("decodes DFS2360: S2 heard on an omni 6 dB antenna at 80 ft", () => {
    const p = d("/234517h4903.50N/07201.75W>DFS2360");
    expect(p.dfs).toEqual({ strength: 2, heightM: 24.4, gainDb: 6 });
    expect(p.rangeKm).toBeUndefined();
    expect(p.comment).toBeUndefined();
    expect(d("!4903.50N/07201.75W\\DFS0132 not heard").dfs).toEqual({
      strength: 0,
      heightM: 6.1,
      gainDb: 3,
      directivityDeg: 90,
    });
  });

  it("decodes a DF report's bearing and NRQ after its course/speed", () => {
    const p = d("=4903.50N/07201.75W\\088/036/270/729");
    expect(p).toMatchObject({ course: 88, speedKn: 36 });
    expect(p.df).toEqual({ bearingDeg: 270, hits: 7, rangeKm: 6.4, accuracyDeg: 1 });
    expect(p.comment).toBeUndefined();
  });

  it("decodes a fixed DF station's report, with or without a timestamp", () => {
    for (const payload of ["=4903.50N/07201.75W\\000/036/270/729", "/092345z4903.50N/07201.75W\\000/000/270/729"]) {
      const p = d(payload);
      expect(p.course).toBeUndefined();
      expect(p.df).toEqual({ bearingDeg: 270, hits: 7, rangeKm: 6.4, accuracyDeg: 1 });
    }
    expect(d("=4903.50N/07201.75W\\.../.../090/914 hunt")).toMatchObject({
      df: { bearingDeg: 90, manual: true, rangeKm: 3.2, accuracyDeg: 32 },
      comment: "hunt",
    });
  });

  it("keeps only the bearing when N is 0, and no accuracy when Q is 0", () => {
    expect(d("=4903.50N/07201.75W\\000/000/180/099").df).toEqual({ bearingDeg: 180 });
    expect(d("=4903.50N/07201.75W\\000/000/180/130").df).toEqual({ bearingDeg: 180, hits: 1, rangeKm: 12.9 });
  });

  it("reads a bearing only with the DF symbol, and only up to 360°", () => {
    const car = d("=4903.50N/07201.75W>088/036/270/729");
    expect(car.df).toBeUndefined();
    expect(car.comment).toBe("/270/729");
    const alt = d("=4903.50N/07201.75W\\088/036/A=001234");
    expect(alt.df).toBeUndefined();
    expect(alt.altitudeM).toBe(Math.round(1234 * 0.3048));
    const wide = d("=4903.50N/07201.75W\\088/036/361/729");
    expect(wide.df).toBeUndefined();
    expect(wide.comment).toBe("/361/729");
  });

  it("decodes the extensions on objects and items", () => {
    expect(d(";DIGI     *092345z4903.50N/07201.75W#PHG5132 hilltop")).toMatchObject({
      kind: "object",
      phg: { powerW: 25, directivityDeg: 90 },
      rangeKm: 12.8,
      comment: "hilltop",
    });
    expect(d(")RPT!4903.50N/07201.75WrRNG0025")).toMatchObject({ kind: "item", rangeKm: 40.2 });
  });

  it("reads no extension from a compressed position's comment, which carries its range in the cs bytes", () => {
    const p = d("!/5L!!<*e7> sTPHG5132");
    expect(p.phg).toBeUndefined();
    expect(p.comment).toBe("PHG5132");
  });

  it("leaves weather reports untouched", () => {
    const w = d("!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900");
    expect(w.kind).toBe("weather");
    expect(w.phg).toBeUndefined();
    expect(w.windDirDeg).toBe(220);
  });
});
