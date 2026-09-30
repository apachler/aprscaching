// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { meshcomHardwareName } from "../src/meshcom/hardware.js";

describe("meshcomHardwareName", () => {
  it("names the devices from the firmware's board ids", () => {
    expect(meshcomHardwareName(4)).toBe("LilyGO T-Beam");
    expect(meshcomHardwareName(8)).toBe("LilyGO T-Deck");
    expect(meshcomHardwareName(9)).toBe("RAK WisBlock RAK4631");
    expect(meshcomHardwareName(46)).toBe("LilyGO T-Deck Plus");
  });
  it("says an id is unknown rather than guessing", () => {
    expect(meshcomHardwareName(13)).toBe("Unknown device (ID 13)");
    expect(meshcomHardwareName(200)).toBe("Unknown device (ID 200)");
  });
});
