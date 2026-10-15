// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decodeAprs, decodeAx25, decodeMicE, encodeAx25, encodeMicE, rfBytes, rfText } from "../src/index.js";

describe("encodeMicE", () => {
  it("writes position, speed and course, and the decoder reads them back", () => {
    // 33°25.64'N 112°07.74'W, 20 knots, 251°
    const { dest, info } = encodeMicE(33 + 25.64 / 60, -(112 + 7.74 / 60), { speedKn: 20, course: 251, symbol: "/j" });
    expect(dest).toBe("SS2UVT"); // 33 25.64, "En Route" (1 1 0), north, +100, west
    const fix = decodeMicE(dest, info)!;
    expect(fix.lat).toBeCloseTo(33 + 25.64 / 60, 5);
    expect(fix.lon).toBeCloseTo(-(112 + 7.74 / 60), 5);
    expect(fix).toMatchObject({ speedKn: 20, course: 251, table: "/", code: "j", messageType: "En Route" });
  });

  it("round-trips positions in every quadrant and every longitude range", () => {
    const points: [number, number][] = [
      [47.0735, 15.4373],
      [-33.8688, 151.2093],
      [51.4779, -0.0015],
      [-0.5, -5.25],
      [64.1466, -21.9426],
      [35.6762, 139.6503],
      [-54.8019, -68.303],
      [40.7128, -74.006],
      [89.999, 105.5],
      [-12.0464, -77.0428],
      [0, 0],
    ];
    for (const [lat, lon] of points) {
      const { dest, info } = encodeMicE(lat, lon);
      const fix = decodeMicE(dest, info)!;
      expect(fix, `${lat},${lon}`).not.toBeNull();
      // hundredths of a minute: within 1/6000° after rounding
      expect(Math.abs(fix.lat - lat)).toBeLessThan(1 / 6000);
      expect(Math.abs(fix.lon - lon)).toBeLessThan(1 / 6000);
      expect(fix.course).toBeUndefined();
      expect(fix.speedKn).toBe(0);
    }
  });

  it("round-trips speed, course, altitude, symbol and comment", () => {
    for (const [speedKn, course] of [
      [0, 360],
      [5, 1],
      [199, 99],
      [200, 180],
      [799, 359],
    ] as const) {
      const { dest, info } = encodeMicE(46.5, 13.8, {
        speedKn,
        course,
        altitudeM: 1450,
        symbol: "\\-",
        comment: "QRV 30m",
      });
      expect(decodeMicE(dest, info)).toMatchObject({
        speedKn,
        course,
        altitudeM: 1450,
        table: "\\",
        code: "-",
        comment: "QRV 30m",
      });
    }
  });

  it("keeps speed and course bytes printable, and a comment that looks like a device prefix stays text", () => {
    const { info } = encodeMicE(48.2, 16.37, { comment: ">not a Kenwood" });
    for (const i of [4, 5]) expect(info.charCodeAt(i)).toBeGreaterThanOrEqual(0x20);
    expect(decodeMicE("T0PPPP", info)).not.toBeNull();
    const { dest } = encodeMicE(48.2, 16.37);
    expect(decodeMicE(dest, info)!.comment).toBe(">not a Kenwood");
  });

  it("carries the message chosen, and never Emergency", () => {
    for (const message of ["Off Duty", "In Service", "Returning", "Committed", "Special", "Priority"] as const) {
      const { dest, info } = encodeMicE(47, 15, { message });
      expect(decodeMicE(dest, info)!.messageType).toBe(message);
    }
    const { dest, info } = encodeMicE(47, 15);
    expect(decodeMicE(dest, info)!.messageType).toBe("En Route");
  });

  it("caps the status text at 43 bytes and drops control characters", () => {
    const long = encodeMicE(47, 15, { comment: "x".repeat(60) });
    expect(long.info.length).toBe(9 + 43);
    const withAlt = encodeMicE(47, 15, { comment: "ü".repeat(30), altitudeM: 100 });
    expect(new TextEncoder().encode(withAlt.info.slice(13)).length).toBeLessThanOrEqual(39);
    expect(encodeMicE(47, 15, { comment: "a\r\nb" }).info.endsWith("ab")).toBe(true);
  });

  it("goes out in an AX.25 frame the APRS decoder reads as a Mic-E position", () => {
    const { dest, info } = encodeMicE(47.0735, 15.4373, { comment: "Grüße" });
    const frame = decodeAx25(encodeAx25({ src: "OE8APR-6", dst: dest, path: [], payload: rfBytes(info) }))!;
    const data = decodeAprs({ ...frame, payload: rfText(frame.payload) }) as {
      kind: string;
      lat: number;
      comment?: string;
    };
    expect(data.kind).toBe("position");
    expect(data.lat).toBeCloseTo(47.0735, 3);
    expect(data.comment).toBe("Grüße");
  });

  it("refuses a position outside ±90° / ±180° and holds 180° at the last position the format names", () => {
    expect(() => encodeMicE(91, 0)).toThrow(RangeError);
    const { dest, info } = encodeMicE(10, -180);
    expect(decodeMicE(dest, info)!.lon).toBeCloseTo(-(179 + 59.99 / 60), 5);
  });
});
