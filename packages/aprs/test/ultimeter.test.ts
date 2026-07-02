// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decodeUltimeter } from "../src/index.js";

/** Build a packet body from 16-bit field values ("----" passes through verbatim). */
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const body = (vals: (number | string)[]) => vals.map((v) => (typeof v === "string" ? v : hex(v))).join("");

describe("ultimeter — Peet Bros PWS serial decode (docs/17 W4)", () => {
  it("decodes a $ULTW data-logger packet to metric", () => {
    // wind 10.0 kph, dir 180°, 77.0 °F, rainTot 12.34 in, 1013.2 hPa, (delta/corr×3), 55.0 %RH, date, time, rainToday 0.50 in, avg
    const pkt = "$ULTW" + body([100, 128, 770, 1234, 10132, 0, 0, 0, 550, 100, 720, 50, 80]);
    const r = decodeUltimeter(pkt)!;
    expect(r.windKn).toBeCloseTo(5.4, 1);         // 10 kph
    expect(r.windDirDeg).toBe(180);               // 128/256·360
    expect(r.tempC).toBeCloseTo(25, 1);           // 77 °F
    expect(r.pressureHpa).toBeCloseTo(1013.2, 1);
    expect(r.humidity).toBeCloseTo(55, 1);        // index 8 in ULTW
    expect(r.rainTodayMm).toBeCloseTo(12.7, 1);   // 0.50 in, index 11
    expect(r.rainTotalMm).toBeCloseTo(313.4, 1);  // 12.34 in
  });

  it("decodes a !! packet (humidity + rain-today at the packet-mode indices, ---- = no sensor)", () => {
    const pkt = "!!" + body([100, 128, 770, 0, 10132, "----", 550, "----", 100, 720, 50, 80]);
    const r = decodeUltimeter(pkt)!;
    expect(r.windDirDeg).toBe(180);
    expect(r.humidity).toBeCloseTo(55, 1);        // index 6 in packet mode
    expect(r.rainTodayMm).toBeCloseTo(12.7, 1);   // index 10
    expect(r.tempC).toBeCloseTo(25, 1);
  });

  it("handles negative temperatures (signed 16-bit)", () => {
    const pkt = "$ULTW" + body([0, 0, 0x10000 - 50, 0, 10000]); // -5.0 °F
    expect(decodeUltimeter(pkt)!.tempC).toBeCloseTo(-20.6, 1);  // (-5−32)·5/9
  });

  it("ignores non-Ultimeter lines and empty packets", () => {
    expect(decodeUltimeter("garbage")).toBeNull();
    expect(decodeUltimeter("$GPRMC,123")).toBeNull();
    expect(decodeUltimeter("!!--------------------")).toBeNull(); // all no-sensor → nothing usable
  });
});
