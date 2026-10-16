// SPDX-License-Identifier: AGPL-3.0-or-later
// My radio's frequency hint: the callsign's country names the APRS frequency, the locale's region answers when
// the callsign does not, and a country with no checked value gets no line rather than a guess.
import { describe, expect, it } from "vitest";
import { formatMhz, frequencyLines, localeRegion } from "../src/rf/aprsFrequency.js";

describe("localeRegion", () => {
  it("reads only a region the locale names", () => {
    expect(localeRegion("de-AT")).toBe("AT");
    expect(localeRegion("en-US")).toBe("US");
    expect(localeRegion("de")).toBeUndefined();
    expect(localeRegion("garbage!!")).toBeUndefined();
  });
});

describe("formatMhz", () => {
  it("shows three decimals in the locale's notation", () => {
    expect(formatMhz(144.8, "en-US")).toBe("144.800");
    expect(formatMhz(144.8, "de-AT")).toBe("144,800");
  });
});

describe("frequencyLines", () => {
  it("names the country of the callsign", () => {
    expect(frequencyLines("OE8APR-7", "en-US").aprs).toBe("APRS in Austria: 144.800 MHz");
    expect(frequencyLines("W1AW", "de-AT").aprs).toBe("APRS in United States: 144,390 MHz");
    expect(frequencyLines("VK2ABC", "en-AU").aprs).toBe("APRS in Australia: 145.175 MHz");
  });

  it("falls back to the locale's region without a callsign", () => {
    expect(frequencyLines("", "en-NZ").aprs).toBe("APRS in New Zealand: 144.575 MHz");
    expect(frequencyLines("", "de-DE").aprs).toBe("APRS in Germany: 144,800 MHz");
  });

  it("has no APRS line for a country without a checked value", () => {
    expect(frequencyLines("HL1ABC", "ko-KR").aprs).toBeNull();
    expect(frequencyLines("", "en").aprs).toBeNull();
  });

  it("names the HF channel by its dial frequency to 100 Hz, its sideband and its tones", () => {
    expect(frequencyLines("", "en-US").hf).toBe(
      "HF APRS: 10.1476 MHz USB dial, 300 baud, 1600/1800 Hz tones, worldwide",
    );
    expect(frequencyLines("", "de-AT").hf).toMatch(/^HF APRS: 10,1476 MHz USB dial/);
  });

  it("always names the LoRa APRS and ISS channels", () => {
    const l = frequencyLines("", "en-US");
    expect(l.lora).toBe("LoRa APRS: 433.775 MHz, the IARU Region 1 channel");
    expect(l.iss).toBe("ISS digipeater: 145.825 MHz, worldwide");
  });
});
