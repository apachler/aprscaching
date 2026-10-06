// SPDX-License-Identifier: AGPL-3.0-or-later
// A decoder's field names read as words, with their units.
import { describe, expect, it } from "vitest";
import { fieldLabel } from "../src/tools/fieldLabel.js";

describe("decoded field labels", () => {
  it("name the fields a position carries", () => {
    expect(fieldLabel("speedKn")).toBe("Speed (kn)");
    expect(fieldLabel("altitudeM")).toBe("Altitude (m)");
    expect(fieldLabel("lat")).toBe("Latitude");
    expect(fieldLabel("messageType")).toBe("Message type");
    expect(fieldLabel("comment")).toBe("Comment");
  });

  it("split any other data name into words, with a trailing unit", () => {
    expect(fieldLabel("windGustKmh")).toBe("Wind gust (km/h)");
    expect(fieldLabel("rainLast24hMm")).toBe("Rain last 24h (mm)");
    expect(fieldLabel("pressureHpa")).toBe("Pressure (hPa)");
  });

  it("leave a tool's own words alone", () => {
    expect(fieldLabel("Station type")).toBe("Station type");
    expect(fieldLabel("M")).toBe("M");
  });
});
