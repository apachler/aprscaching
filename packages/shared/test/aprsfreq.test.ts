// SPDX-License-Identifier: MIT
// The APRS frequency hint: a callsign's country first, the browser locale's region after it, Europe's default
// for a European country the table does not list, and no answer at all for a country with no checked value.
import { describe, expect, it } from "vitest";
import {
  ISS_APRS_MHZ,
  LORA_APRS_MHZ,
  aprsFrequencyForCall,
  aprsFrequencyForCountry,
  aprsFrequencyHint,
} from "../src/index.js";

describe("aprsFrequencyForCountry", () => {
  it("answers each listed country", () => {
    const table: [string, number][] = [
      ["US", 144.39],
      ["ca", 144.39],
      ["MX", 144.39],
      ["AR", 144.39],
      ["CL", 144.39],
      ["TH", 144.39],
      ["NZ", 144.575],
      ["CN", 144.64],
      ["TW", 144.64],
      ["JP", 144.66],
      ["ZA", 144.8],
      ["RU", 144.8],
      ["UY", 144.93],
      ["PA", 144.93],
      ["AU", 145.175],
      ["BR", 145.57],
    ];
    for (const [iso, mhz] of table) expect(aprsFrequencyForCountry(iso), iso).toMatchObject({ mhz, basis: "country" });
  });

  it("falls back to 144.800 MHz in Europe, and to nothing elsewhere", () => {
    expect(aprsFrequencyForCountry("AT")).toEqual({ mhz: 144.8, country: "AT", basis: "europe" });
    expect(aprsFrequencyForCountry("de")).toMatchObject({ mhz: 144.8, country: "DE" });
    expect(aprsFrequencyForCountry("KR")).toBeUndefined();
    expect(aprsFrequencyForCountry("")).toBeUndefined();
  });
});

describe("aprsFrequencyForCall", () => {
  it("reads the country from the callsign's DXCC prefix", () => {
    expect(aprsFrequencyForCall("W1AW")).toMatchObject({ mhz: 144.39, country: "US" });
    expect(aprsFrequencyForCall("KL7ABC-9")).toMatchObject({ mhz: 144.39, country: "US" });
    expect(aprsFrequencyForCall("VE3XYZ")).toMatchObject({ mhz: 144.39, country: "CA" });
    expect(aprsFrequencyForCall("VK2ABC")).toMatchObject({ mhz: 145.175, country: "AU" });
    expect(aprsFrequencyForCall("JA1XYZ")).toMatchObject({ mhz: 144.66, country: "JP" });
    expect(aprsFrequencyForCall("PY2XYZ")).toMatchObject({ mhz: 145.57, country: "BR" });
    expect(aprsFrequencyForCall("UA9ABC")).toMatchObject({ mhz: 144.8, country: "RU" });
  });

  it("gives a European entity the Region 1 channel by its continent", () => {
    const at = aprsFrequencyForCall("OE8APR-7");
    expect(at).toMatchObject({ mhz: 144.8, basis: "europe" });
    expect(at?.entity?.name).toBe("Austria");
    expect(aprsFrequencyForCall("DL/W1AW")).toMatchObject({ mhz: 144.8, basis: "europe" });
  });

  it("has no answer for an entity outside the table and outside Europe", () => {
    expect(aprsFrequencyForCall("KH6XYZ")).toBeUndefined();
    expect(aprsFrequencyForCall("HL1ABC")).toBeUndefined();
    expect(aprsFrequencyForCall("")).toBeUndefined();
  });
});

describe("aprsFrequencyHint", () => {
  it("prefers the callsign's country over the locale's region", () => {
    expect(aprsFrequencyHint({ call: "W1AW", localeRegion: "AT" })).toMatchObject({ mhz: 144.39 });
    expect(aprsFrequencyHint({ call: "HL1ABC", localeRegion: "NZ" })).toMatchObject({ mhz: 144.575 });
    expect(aprsFrequencyHint({ localeRegion: "AU" })).toMatchObject({ mhz: 145.175 });
    expect(aprsFrequencyHint({})).toBeUndefined();
  });

  it("names the LoRa APRS and ISS channels", () => {
    expect(LORA_APRS_MHZ).toBe(433.775);
    expect(ISS_APRS_MHZ).toBe(145.825);
  });
});
