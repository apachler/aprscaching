// SPDX-License-Identifier: AGPL-3.0-or-later
// The position an ingested packet contributes: decoded from its payload, or pre-parsed by the ingest box,
// and in both cases on the globe.
import { describe, it, expect } from "vitest";
import { fixOf } from "../src/ingest.js";

const pkt = (payload: string, parsed?: unknown) => ({ src: "OE8APR-9", dst: "APRS", path: [], payload, parsed });

describe("ingest fix", () => {
  it("takes the decoded position", () => {
    expect(fixOf(pkt("!4704.41N/01526.27E>hi"))).toMatchObject({ lat: 47.0735, own: true });
  });

  it("carries the radio range a PHG works out to, or an RNG sends, and leaves the extension out of the comment", () => {
    expect(fixOf(pkt("!4704.41N/01526.27E#PHG5132 hilltop"))).toMatchObject({ rangeKm: 12.8, comment: "hilltop" });
    expect(fixOf(pkt("!4704.41N/01526.27E#RNG0050"))).toMatchObject({ rangeKm: 80.5 });
    expect(fixOf(pkt("!4704.41N/01526.27E>hi"))?.rangeKm).toBeUndefined();
  });

  it("refuses a decoded position past the poles or with minutes of 60 or more", () => {
    expect(fixOf(pkt("!9530.00N/01526.27E>"))).toBeNull();
    expect(fixOf(pkt("!4775.00N/01526.27E>"))).toBeNull();
  });

  it("takes the added precision of a !DAO! token and leaves the token out of the comment", () => {
    expect(fixOf(pkt("!4903.50N/07201.75W>home !W12!"))).toMatchObject({
      lat: 49.05835,
      lon: -72.0292,
      comment: "home",
    });
  });

  it("takes a raw NMEA fix as the station's own position, its symbol from the destination", () => {
    const rmc = { ...pkt("$GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E*52"), dst: "GPSMV" };
    expect(fixOf(rmc)).toMatchObject({
      lat: 33.823837,
      lon: -117.006202,
      symbol: "/>",
      course: 89,
      speedKn: 43,
      own: true,
    });
    const gga = pkt("$GPGGA,102705,5157.9762,N,00029.3256,W,1,04,2.0,75.7,M,47.6,M,,*62");
    expect(fixOf(gga)).toMatchObject({ lat: 51.96627, altitudeM: 76, symbol: "/>", own: true }); // SSID -9: a car
  });

  it("takes no fix from a void or corrupt NMEA sentence", () => {
    expect(fixOf(pkt("$GPRMC,063909,V,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E"))).toBeNull();
    expect(fixOf(pkt("$GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E*53"))).toBeNull();
  });

  it("never takes a status report's Maidenhead locator as a fix: its cell spans kilometres", () => {
    expect(fixOf(pkt(">IO91SX/G"))).toBeNull();
    expect(fixOf(pkt(">JN77sb/- QTH"))).toBeNull();
  });

  it("takes a pre-parsed fix only when it is on the globe", () => {
    expect(fixOf(pkt(">status", { lat: 47.1, lon: 15.4, symbol: "/>" }))).toMatchObject({ lat: 47.1, lon: 15.4 });
    for (const parsed of [
      { lat: 123, lon: 15 },
      { lat: 47, lon: -200 },
      { lat: "47", lon: 15 },
      { lat: Number.NaN, lon: 15 },
      { lat: 47, lon: null },
    ])
      expect(fixOf(pkt(">status", parsed)), JSON.stringify(parsed)).toBeNull();
  });
});
