// SPDX-License-Identifier: AGPL-3.0-or-later
// The Find view's compass: headings from both browsers' orientation events, the needle's short way round, the
// direction of travel from GPS when there is no compass, and when the needle hands over to the eye.
import { describe, expect, it } from "vitest";
import {
  atThePin,
  courseTracker,
  headingFromOrientation,
  needsCalibration,
  smoothAngle,
  turn,
} from "../src/geo/heading.js";

describe("the heading from an orientation event", () => {
  it("takes Safari's compass heading, clockwise from north, plus the screen's rotation", () => {
    expect(headingFromOrientation({ alpha: 10, webkitCompassHeading: 90, webkitCompassAccuracy: 10 }, 0)).toEqual({
      deg: 90,
      accuracyDeg: 10,
    });
    expect(headingFromOrientation({ alpha: 10, webkitCompassHeading: 300 }, 90)?.deg).toBe(30);
  });

  it("turns Chromium's absolute alpha, counter-clockwise from north, into a heading", () => {
    expect(headingFromOrientation({ alpha: 0, absolute: true }, 0)?.deg).toBe(0);
    expect(headingFromOrientation({ alpha: 90, absolute: true }, 0)?.deg).toBe(270);
    expect(headingFromOrientation({ alpha: 90, absolute: true }, 90)?.deg).toBe(0);
  });

  it("ignores an orientation relative to where the page started", () => {
    expect(headingFromOrientation({ alpha: 45, absolute: false }, 0)).toBeNull();
    expect(headingFromOrientation({ alpha: null, absolute: true }, 0)).toBeNull();
  });

  it("asks for calibration when the browser reports a poor or unknown accuracy", () => {
    expect(needsCalibration({ deg: 0, accuracyDeg: 40 })).toBe(true);
    expect(needsCalibration({ deg: 0, accuracyDeg: -1 })).toBe(true);
    expect(needsCalibration({ deg: 0, accuracyDeg: 10 })).toBe(false);
    expect(needsCalibration({ deg: 0, accuracyDeg: null })).toBe(false);
  });
});

describe("the needle", () => {
  it("turns the short way round", () => {
    expect(turn(350, 10)).toBe(20);
    expect(turn(10, 350)).toBe(-20);
    expect(turn(0, 180)).toBe(180);
  });

  it("eases across north without swinging through the dial", () => {
    expect(smoothAngle(null, 370)).toBe(10);
    const eased = smoothAngle(355, 5, 0.5);
    expect(eased).toBeCloseTo(0);
  });
});

describe("the direction of travel", () => {
  it("is known once the walker has moved further than the readings' uncertainty", () => {
    const course = courseTracker(8);
    expect(course(47.0, 15.0, 5)).toBeNull();
    expect(course(47.00003, 15.0, 5)).toBeNull(); // about 3 m: within the noise
    expect(course(47.0002, 15.0, 5)).toBeCloseTo(0, 0); // about 22 m north
    expect(course(47.0002, 15.0001, 5)).toBeCloseTo(0, 0); // 7.6 m: holds the last course
    expect(course(47.0002, 15.0004, 5)).toBeCloseTo(90, 0); // east
  });
});

describe("at the pin", () => {
  it("hands over within the reading's accuracy, and never closer than ten metres", () => {
    expect(atThePin(8, 4)).toBe(true);
    expect(atThePin(12, 4)).toBe(false);
    expect(atThePin(25, 30)).toBe(true);
  });
});
