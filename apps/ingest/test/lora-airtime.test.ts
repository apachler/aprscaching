// SPDX-License-Identifier: AGPL-3.0-or-later
// LoRa time on air against the Semtech formula's published values, and the presets' figures the status shows.
import { describe, it, expect } from "vitest";
import { loraAirtimeMs, loraBitRate, loraSymbolMs } from "../src/lora-airtime.js";

describe("loraAirtimeMs", () => {
  it("matches the formula's reference values", () => {
    // SF7, 125 kHz, CR 4:5, 10 bytes, explicit header, CRC on: 41.216 ms
    expect(loraAirtimeMs({ sf: 7, bwKhz: 125, cr: 5 }, 10)).toBeCloseTo(41.216, 3);
    // SF12, 125 kHz, CR 4:5, 64 bytes (a 51-byte LoRaWAN payload and its 13-byte frame): low-data-rate
    // optimisation on, 2793.472 ms
    expect(loraAirtimeMs({ sf: 12, bwKhz: 125, cr: 5 }, 64)).toBeCloseTo(2793.472, 3);
  });

  it("gives the presets' airtime for a 60-byte packet", () => {
    expect(Math.round(loraAirtimeMs({ sf: 9, bwKhz: 125, cr: 7 }, 60))).toBe(484);
    expect(Math.round(loraAirtimeMs({ sf: 8, bwKhz: 125, cr: 6 }, 60))).toBe(238);
    expect(Math.round(loraAirtimeMs({ sf: 12, bwKhz: 125, cr: 5 }, 60))).toBe(2630);
  });

  it("switches low-data-rate optimisation on past 16 ms a symbol, unless told otherwise", () => {
    expect(loraSymbolMs({ sf: 11, bwKhz: 125 })).toBeCloseTo(16.384, 3);
    const auto = loraAirtimeMs({ sf: 11, bwKhz: 125, cr: 5 }, 60);
    expect(auto).toBe(loraAirtimeMs({ sf: 11, bwKhz: 125, cr: 5, lowDataRate: true }, 60));
    expect(auto).toBeGreaterThan(loraAirtimeMs({ sf: 11, bwKhz: 125, cr: 5, lowDataRate: false }, 60));
  });

  it("grows with the payload, the coding rate and the preamble", () => {
    const m = { sf: 9, bwKhz: 125, cr: 5 };
    expect(loraAirtimeMs(m, 100)).toBeGreaterThan(loraAirtimeMs(m, 50));
    expect(loraAirtimeMs({ ...m, cr: 8 }, 50)).toBeGreaterThan(loraAirtimeMs(m, 50));
    expect(loraAirtimeMs({ ...m, preamble: 16 }, 50)).toBeGreaterThan(loraAirtimeMs(m, 50));
    expect(loraAirtimeMs({ ...m, bwKhz: 250 }, 50)).toBeCloseTo(loraAirtimeMs(m, 50) / 2, 6);
  });

  it("never counts fewer than the header's 8 payload symbols", () => {
    const m = { sf: 12, bwKhz: 125, cr: 5 };
    expect(loraAirtimeMs(m, 0)).toBeCloseTo((8 + 4.25 + 8) * loraSymbolMs(m), 6);
  });
});

describe("loraBitRate", () => {
  it("gives the presets' raw rates", () => {
    expect(Math.round(loraBitRate({ sf: 9, bwKhz: 125, cr: 7 }))).toBe(1256);
    expect(Math.round(loraBitRate({ sf: 8, bwKhz: 125, cr: 6 }))).toBe(2604);
    expect(Math.round(loraBitRate({ sf: 12, bwKhz: 125, cr: 5 }))).toBe(293);
  });
});
