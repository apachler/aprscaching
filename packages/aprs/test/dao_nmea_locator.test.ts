// SPDX-License-Identifier: MIT
// The `!DAO!` precision and datum option, raw NMEA sentences and the Maidenhead locator of a status report, as
// APRS 1.2 lays them out.
import { describe, it, expect } from "vitest";
import { decodeAprs, decodeMicE, parseNmea, symbolFromAddress, fromMaidenhead } from "../src/index.js";

const frame = (payload: string, dst = "APRS", src = "TEST") => ({ src, dst, path: [], payload, raw: "" });

describe("!DAO! precision and datum", () => {
  const d = (p: string) => decodeAprs(frame(p)) as any;
  it("adds a human-readable third decimal of the minutes and drops the token from the comment", () => {
    const pos = d("!4903.50N/07201.75W>Going home !W12!");
    expect(pos).toMatchObject({ lat: 49.05835, lon: -72.0292, datum: "W", comment: "Going home" });
  });
  it("adds base-91 digits from a lowercase datum", () => {
    expect(d("!4903.50N/07201.75W>!w{{!")).toMatchObject({ lat: 49.058498, lon: -72.029332, datum: "W" });
    expect(d("!4903.50N/07201.75W>!w!!!")).toMatchObject({ lat: 49.058333, lon: -72.029167 });
  });
  it("moves a southern or eastern position away from the equator or meridian alike", () => {
    expect(d("!4903.50S/07201.75E>!W55!")).toMatchObject({ lat: -49.058417, lon: 72.02925 });
  });
  it("keeps the datum without added precision for spaces, a local datum or an ambiguous position", () => {
    expect(d("!4903.50N/07201.75W>!N  !")).toMatchObject({ lat: 49.058333, datum: "N" });
    expect(d("!4903.50N/07201.75W>!312!")).toMatchObject({ lat: 49.058333, datum: "3" });
    const amb = d("!4903.5 N/07201.75W>!W12!");
    expect(amb).toMatchObject({ ambiguity: 1, lat: 49.058333, lon: -72.028333, datum: "W" });
    expect(amb.comment).toBeUndefined();
  });
  it("leaves a token whose digits do not fit its datum's case in the comment", () => {
    const pos = d("!4903.50N/07201.75W>!Wab!");
    expect(pos.datum).toBeUndefined();
    expect(pos.comment).toBe("!Wab!");
  });
  it("names the datum of a compressed position and places a weather report with it", () => {
    expect(d("=/5L!!<*e7> sT!W12!")).toMatchObject({ lat: 49.5, datum: "W" });
    expect(d("!4903.50N/07201.75W_220/004g005t077!W12!")).toMatchObject({ kind: "weather", lat: 49.05835 });
  });
  it("reads the token in a Mic-E status text once the device suffix is gone", () => {
    const m = decodeMicE("S32U6T", '`(_fn"Oj/]Hi!W12!=')!;
    expect(m).toMatchObject({ lat: 33.42735, lon: -12.129033, datum: "W", comment: "Hi" });
  });
});

describe("raw NMEA", () => {
  const d = (p: string, dst = "GPSMV", src = "TEST") => decodeAprs(frame(p, dst, src)) as any;
  it("decodes an RMC fix with its course, speed and time, the symbol from the destination", () => {
    expect(d("$GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E*52")).toEqual({
      kind: "position",
      lat: 33.823837,
      lon: -117.006202,
      symbol: expect.objectContaining({ table: "/", code: ">", label: "Car" }),
      nmea: "RMC",
      course: 89,
      speedKn: 43,
      timestamp: "063909h",
    });
  });
  it("decodes a GGA fix with its altitude, and a GLL fix sent without a checksum", () => {
    expect(d("$GPGGA,102705,5157.9762,N,00029.3256,W,1,04,2.0,75.7,M,47.6,M,,*62")).toMatchObject({
      kind: "position",
      lat: 51.96627,
      lon: -0.48876,
      altitudeM: 76,
      nmea: "GGA",
    });
    expect(d("$GPGLL,2554.459,N,08020.187,W,154027.281,A")).toMatchObject({ lat: 25.90765, nmea: "GLL" });
  });
  it("reads the other GNSS talkers", () => {
    const rmc = "GNRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E";
    let sum = 0;
    for (const c of rmc) sum ^= c.charCodeAt(0);
    const line = `$${rmc}*${sum.toString(16).toUpperCase().padStart(2, "0")}\r\n`;
    expect(d(line)).toMatchObject({ kind: "position", nmea: "RMC", lat: 33.823837 });
  });
  it("refuses a bad checksum, a void fix, a position off the globe and a VTG, which has no position", () => {
    expect(d("$GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E*53").kind).toBe("other");
    expect(d("$GPRMC,063909,V,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E").kind).toBe("other");
    expect(d("$GPGLL,2554.459,N,08020.187,W,154027.281,V").kind).toBe("other");
    expect(d("$GPGGA,102705,5157.9762,N,00029.3256,W,0,00,,,M,,M,,").kind).toBe("other");
    expect(d("$GPRMC,063909,A,9349.4302,N,11700.3721,W,0,0,291099,,").kind).toBe("other");
    expect(d("$GPVTG,318.7,T,,M,35.1,N,65.0,K*69").kind).toBe("other");
    expect(parseNmea("$GPVTG,318.7,T,,M,35.1,N,65.0,K*69")).toEqual({ sentence: "VTG", course: 319, speedKn: 35.1 });
  });
  it("decodes a WPL waypoint as an item named after it", () => {
    expect(d("$GPWPL,4917.16,N,12310.64,W,003*65")).toMatchObject({ kind: "item", name: "003", lat: 49.286 });
  });
  it("takes the symbol from GPSxyz, GPSCnn or GPSEnn, then from the source SSID", () => {
    const gll = "$GPGLL,2554.459,N,08020.187,W,154027.281,A";
    expect(d(gll, "GPSC12").symbol).toMatchObject({ table: "/", code: "," });
    expect(d(gll, "GPSOM").symbol).toMatchObject({ table: "\\", code: "," });
    expect(d(gll, "GPSE12").symbol).toMatchObject({ table: "\\", code: "," });
    expect(d(gll, "GPSNV3").symbol).toMatchObject({ table: "3", code: ">", overlay: "3" });
    expect(d(gll, "SPCHW").symbol).toMatchObject({ table: "/", code: "_" });
    expect(d(gll, "APRS", "TEST-7").symbol).toMatchObject({ table: "/", code: "'" });
    expect(d(gll, "APRS", "TEST").symbol).toBeUndefined();
    expect(symbolFromAddress("GPSMV", "TEST-7")).toMatchObject({ code: ">" }); // the destination comes first
  });
  it("leaves other $ reports alone", () => {
    expect(d("$ULTW0031003702CE0069----000086A00040430C0F0000003F").kind).not.toBe("position");
  });
});

describe("Maidenhead locator in a status report", () => {
  const d = (p: string) => decodeAprs(frame(p)) as any;
  it("decodes the locator as its cell's centre with the symbol, the text after a space as the status", () => {
    expect(d(">IO91SX/- My house")).toEqual({
      kind: "status",
      text: "My house",
      locator: { grid: "IO91SX", lat: 51.979167, lon: -0.458333 },
      symbol: expect.objectContaining({ table: "/", code: "-" }),
    });
    expect(d(">IO91/G")).toMatchObject({ text: "", locator: { grid: "IO91", lat: 51.5, lon: -1 } });
    expect(d(">io91sx/G")).toMatchObject({ locator: { grid: "IO91SX" } });
  });
  it("reads no locator after a timestamp, without the space before the text, or for a text that is not one", () => {
    expect(d(">092345zIO91SX/G")).toEqual({ kind: "status", text: "IO91SX/G", timestamp: "092345z" });
    expect(d(">IO91SX/-^B7")).toEqual({ kind: "status", text: "IO91SX/-^B7" });
    expect(d(">Net control")).toEqual({ kind: "status", text: "Net control" });
    expect(d(">ZZ91SX/G").locator).toBeUndefined();
  });
  it("reads a locator leading a Mic-E status text and keeps the Mic-E position", () => {
    const m = decodeMicE("S32U6T", '`(_fn"Oj/]IO91SX/G Hello=')!;
    expect(m).toMatchObject({ lat: 33.427333, code: "j", comment: "Hello", locator: { grid: "IO91SX" } });
    expect(decodeAprs(frame('`(_fn"Oj/]IO91SX/G Hello=', "S32U6T"))).toMatchObject({
      kind: "position",
      locator: { grid: "IO91SX" },
    });
  });
  it("finds the centre of a 4- or 6-character locator", () => {
    expect(fromMaidenhead("JN77")).toEqual({ lat: 47.5, lon: 15 });
    expect(fromMaidenhead("JN77sb")).toEqual({ lat: 47.0625, lon: 15.541667 });
    expect(fromMaidenhead("JN7")).toBeNull();
    expect(fromMaidenhead("SN77")).toBeNull();
  });
});
