// SPDX-License-Identifier: AGPL-3.0-or-later
// The beacon position sources' parsers: Termux:API's termux-location output, gpsd's TPV reports and NMEA from a
// serial GPS receiver.
import { describe, it, expect } from "vitest";
import { JsonObjectSplitter, NmeaFixer, parseGpsdLine, parseTermuxLocation } from "../src/gps.js";

/** What `termux-location -p gps -r updates` prints: one pretty-printed object per fix. */
const TERMUX = `{
  "latitude": 47.0712345,
  "longitude": 15.4398765,
  "altitude": 368.4,
  "accuracy": 4.2,
  "vertical_accuracy": 3.1,
  "bearing": 271.5,
  "speed": 13.9,
  "elapsedMs": 42,
  "provider": "gps"
}
{
  "latitude": 47.0713,
  "longitude": 15.4390,
  "altitude": 369.0,
  "accuracy": 3.9,
  "bearing": 0.0,
  "speed": 0.0,
  "elapsedMs": 17,
  "provider": "gps"
}
`;

describe("termux-location", () => {
  it("splits the pretty-printed objects across any chunking", () => {
    const s = new JsonObjectSplitter();
    const objs = [...TERMUX].flatMap((ch) => s.push(ch));
    expect(objs).toHaveLength(2);
    expect(new JsonObjectSplitter().push(TERMUX.slice(0, 50))).toEqual([]);
  });

  it("reads a fix: speed in km/h, the bearing only while moving", () => {
    const [a, b] = new JsonObjectSplitter().push(TERMUX);
    expect(parseTermuxLocation(a, 1)).toEqual({
      lat: 47.0712345,
      lon: 15.4398765,
      speedKmh: expect.closeTo(50.04, 2),
      course: 272,
      altitudeM: 368.4,
      at: 1,
    });
    expect(parseTermuxLocation(b, 2)).toMatchObject({ speedKmh: 0 });
    expect(parseTermuxLocation(b, 2)!.course).toBeUndefined();
    expect(parseTermuxLocation({ latitude: 95, longitude: 0 }, 3)).toBeNull();
    expect(parseTermuxLocation({ error: "location not available" }, 3)).toBeNull();
  });

  it("ignores text between objects and a brace inside a string", () => {
    const s = new JsonObjectSplitter();
    expect(s.push('noise {"provider":"g}ps","latitude":1,"longitude":2} more')).toEqual([
      { provider: "g}ps", latitude: 1, longitude: 2 },
    ]);
  });
});

describe("gpsd", () => {
  it("reads a TPV report with a fix, and nothing else", () => {
    const tpv =
      '{"class":"TPV","device":"/dev/ttyACM0","mode":3,"time":"2026-10-15T10:00:00.000Z","lat":47.07,"lon":15.42,"altMSL":370.2,"track":181.3,"speed":25.0}';
    expect(parseGpsdLine(tpv, 5)).toEqual({
      lat: 47.07,
      lon: 15.42,
      speedKmh: 90,
      course: 181,
      altitudeM: 370.2,
      at: 5,
    });
    expect(parseGpsdLine('{"class":"TPV","mode":1}', 5)).toBeNull();
    expect(parseGpsdLine('{"class":"SKY","satellites":[]}', 5)).toBeNull();
    expect(parseGpsdLine('{"class":"VERSION","release":"3.25"}', 5)).toBeNull();
    expect(parseGpsdLine("not json", 5)).toBeNull();
  });
});

describe("NMEA", () => {
  const rmc = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A";
  const gga = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";

  it("an RMC gives position, speed and course; the GGA before it the altitude", () => {
    const n = new NmeaFixer();
    expect(n.line(gga, 1)).toMatchObject({ lat: expect.closeTo(48.1173, 4), altitudeM: 545 });
    const f = n.line(rmc, 2)!;
    expect(f).toMatchObject({ lat: expect.closeTo(48.1173, 4), lon: expect.closeTo(11.5167, 4), course: 84 });
    expect(f.speedKmh).toBeCloseTo(22.4 * 1.852, 2);
    expect(f.altitudeM).toBe(545);
    // once RMC flows, a GGA only updates the altitude
    expect(n.line(gga, 3)).toBeNull();
  });

  it("drops a void fix and a wrong checksum", () => {
    const n = new NmeaFixer();
    expect(n.line("$GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*7D", 1)).toBeNull();
    expect(n.line(rmc.replace("*6A", "*00"), 1)).toBeNull();
    expect(n.line("$GPGSV,3,1,11,03,03,111,00*74", 1)).toBeNull();
  });
});
