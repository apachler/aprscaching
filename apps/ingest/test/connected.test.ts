// SPDX-License-Identifier: AGPL-3.0-or-later
// The NET/ROM node's timing from env: a too-short interval would key the transmitter every few seconds, and
// a path quality outside 0–255 would corrupt every route learned through it.
import { describe, it, expect, vi } from "vitest";
import { netromSettings, NETROM_BROADCAST_MIN_MS } from "../src/connected.js";

describe("netromSettings", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it("uses the defaults when unset or not a number", () => {
    expect(netromSettings({})).toEqual({ broadcastMs: 3_600_000, pathQuality: 192 });
    expect(netromSettings({ NETROM_BROADCAST_MS: "soon", NETROM_PATH_QUALITY: "good" })).toEqual({
      broadcastMs: 3_600_000,
      pathQuality: 192,
    });
  });

  it("floors the broadcast interval", () => {
    expect(netromSettings({ NETROM_BROADCAST_MS: "1000" }).broadcastMs).toBe(NETROM_BROADCAST_MIN_MS);
    expect(netromSettings({ NETROM_BROADCAST_MS: "900000" }).broadcastMs).toBe(900_000);
  });

  it("clamps the path quality to 0–255", () => {
    expect(netromSettings({ NETROM_PATH_QUALITY: "999" }).pathQuality).toBe(255);
    expect(netromSettings({ NETROM_PATH_QUALITY: "-5" }).pathQuality).toBe(0);
    expect(netromSettings({ NETROM_PATH_QUALITY: "128" }).pathQuality).toBe(128);
  });
});
