// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildDeviceIndex, deviceByMicE, deviceByTocall, identifyDevice } from "../src/index.js";

// A hand-written table in the shape of the device database: the matcher's tests never read the real data.
const TABLE = {
  classes: { rig: { shown: "Rig" }, ht: { shown: "HT" }, software: { shown: "Desktop software" } },
  tocalls: {
    APXY12: { vendor: "Maker", model: "Exact One", class: "software" },
    "APXY??": { vendor: "Maker", model: "Any XY", class: "software" },
    APXYnn: { vendor: "Maker", model: "Numbered XY" },
    "APX???": { vendor: "Maker", model: "Any X" },
    "APQ*": { vendor: "Open", model: "Q family" },
    "APQR??": { vendor: "Open", model: "QR line" },
    APVEND: { vendor: "Only Vendor" },
    APNONE: { class: "rig" },
    APRS: { model: "Unknown" },
    APZEXP: { vendor: "Unknown", model: "Experimental" },
  },
  mice: { _0: { vendor: "Yaesu", model: "FT3D", class: "ht" }, "_ ": { vendor: "Yaesu", model: "VX-8", class: "ht" } },
  micelegacy: {
    "]": { vendor: "Kenwood", model: "TM-D700", class: "rig", prefix: "]" },
    "]=": { vendor: "Kenwood", model: "TM-D710", class: "rig", prefix: "]", suffix: "=" },
  },
  meta: { generation_time: "2026-01-01T00:00:00Z" },
};

const index = buildDeviceIndex(TABLE)!;

describe("device by tocall", () => {
  it("prefers an exact tocall over any pattern", () => {
    expect(deviceByTocall(index, "APXY12")).toEqual({ name: "Exact One", vendor: "Maker", class: "Desktop software" });
  });
  it("picks the most specific pattern: a digit wildcard over any character, more literals over fewer", () => {
    expect(deviceByTocall(index, "APXY34")?.name).toBe("Numbered XY");
    expect(deviceByTocall(index, "APXYAB")?.name).toBe("Any XY");
    expect(deviceByTocall(index, "APXZAB")?.name).toBe("Any X");
    expect(deviceByTocall(index, "APQR12")?.name).toBe("QR line");
    expect(deviceByTocall(index, "APQ")?.name).toBe("Q family");
    expect(deviceByTocall(index, "APQZ9")?.name).toBe("Q family");
  });
  it("ignores the SSID and letter case, and holds a fixed pattern to its length", () => {
    expect(deviceByTocall(index, "apxy12-3")?.name).toBe("Exact One");
    expect(deviceByTocall(index, "APXY1")).toBeNull();
    expect(deviceByTocall(index, "APRSXX")).toBeNull();
  });
  it("names a device by its vendor when the entry has no model, and skips an entry naming neither", () => {
    expect(deviceByTocall(index, "APVEND")).toEqual({ name: "Only Vendor" });
    expect(deviceByTocall(index, "APNONE")).toBeNull();
  });
  it("reads Unknown as no name", () => {
    expect(deviceByTocall(index, "APRS")).toBeNull();
    expect(deviceByTocall(index, "APZEXP")).toEqual({ name: "Experimental" });
  });
});

describe("device by Mic-E code", () => {
  it("reads a two-character suffix after a ` or ' prefix", () => {
    expect(deviceByMicE(index, { prefix: "`", suffix: "_0" })).toEqual({ name: "FT3D", vendor: "Yaesu", class: "HT" });
    expect(deviceByMicE(index, { prefix: "'", suffix: "_ " })?.name).toBe("VX-8");
    expect(deviceByMicE(index, { prefix: "`", suffix: "zz" })).toBeNull();
  });
  it("reads a Kenwood prefix with its suffix, else the prefix alone", () => {
    expect(deviceByMicE(index, { prefix: "]", suffix: "=" })?.name).toBe("TM-D710");
    expect(deviceByMicE(index, { prefix: "]", suffix: "x" })?.name).toBe("TM-D700");
    expect(deviceByMicE(index, { prefix: ">", suffix: "^" })).toBeNull();
  });
  it("ignores the destination of a Mic-E packet", () => {
    expect(identifyDevice(index, { dst: "APXY12", micE: { prefix: "]", suffix: "=" } })?.name).toBe("TM-D710");
    expect(identifyDevice(index, { dst: "APXY12", isMicE: true })).toBeNull();
    expect(identifyDevice(index, { dst: "APXY12" })?.name).toBe("Exact One");
  });
});

describe("building the index", () => {
  it("refuses what is not a device table", () => {
    expect(buildDeviceIndex(null)).toBeNull();
    expect(buildDeviceIndex([])).toBeNull();
    expect(buildDeviceIndex({ tocalls: "x" })).toBeNull();
    expect(buildDeviceIndex({ meta: {} })).toBeNull();
  });
  it("skips over-long keys and bounds every text", () => {
    const i = buildDeviceIndex({ tocalls: { APLONGKEY12: { model: "x" }, APOK: { model: "y".repeat(500) } } })!;
    expect(deviceByTocall(i, "APOK")?.name).toHaveLength(120);
    expect(i.exact.size).toBe(1);
  });
});
