// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sanitizeMeshcomMeta, meshcomQuality, meshcomBattLevel } from "../src/meshcom.js";

describe("sanitizeMeshcomMeta", () => {
  it("keeps valid fields", () => {
    const m = {
      srcType: "lora",
      direct: true,
      path: ["OE8XYZ-1"],
      receiver: "OE8APR-12",
      rssi: -95,
      snr: 3.5,
      hwId: 9,
      firmware: "4.35t",
      batt: 50,
    };
    expect(sanitizeMeshcomMeta(m)).toEqual(m);
  });
  it("drops invalid fields one by one, never clamps", () => {
    expect(
      sanitizeMeshcomMeta({
        srcType: "lora",
        rssi: 5,
        snr: 99,
        hwId: 1.5,
        batt: -1,
        firmware: "4.35 t",
        receiver: "home",
      }),
    ).toEqual({ srcType: "lora" });
    expect(sanitizeMeshcomMeta({ path: ["OE8XYZ-1", "not a call"] })).toBeNull();
    expect(sanitizeMeshcomMeta({ path: Array(10).fill("OE8XYZ-1") })).toBeNull();
    expect(sanitizeMeshcomMeta({ srcType: "mqtt" })).toBeNull();
  });
  it("keeps a signal report only for a LoRa hearing", () => {
    expect(sanitizeMeshcomMeta({ srcType: "udp", rssi: -90, snr: 2 })).toEqual({ srcType: "udp" });
    expect(sanitizeMeshcomMeta({ rssi: -90 })).toBeNull();
  });
  it("rejects what is not an object", () => {
    for (const v of [null, undefined, 1, "x", [], true]) expect(sanitizeMeshcomMeta(v)).toBeNull();
  });
});

describe("plain-language buckets", () => {
  it("rates signal by SNR, else RSSI", () => {
    expect(meshcomQuality({ snr: 8 })).toBe("strong");
    expect(meshcomQuality({ snr: 0, rssi: -130 })).toBe("usable");
    expect(meshcomQuality({ snr: -12 })).toBe("weak");
    expect(meshcomQuality({ rssi: -85 })).toBe("strong");
    expect(meshcomQuality({ rssi: -115 })).toBe("weak");
    expect(meshcomQuality({})).toBeNull();
  });
  it("buckets the battery", () => {
    expect([90, 40, 10].map(meshcomBattLevel)).toEqual(["high", "medium", "low"]);
    expect(meshcomBattLevel(null)).toBeNull();
  });
});
