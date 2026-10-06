// SPDX-License-Identifier: AGPL-3.0-or-later
// A push that did not turn on says why, per cause; the iPhone advice shows only where it applies.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { iosOutsideApp, pushFailureText, type PushFailure } from "../src/push.js";

const ALL: PushFailure[] = ["denied", "unconfigured", "unsupported", "worker", "subscribe", "network", "server"];

describe("push failures", () => {
  it("each have their own words", () => {
    const texts = ALL.map((f) => pushFailureText(f));
    expect(new Set(texts).size).toBe(ALL.length);
  });

  it("speak of the home screen only on an iPhone or iPad outside the installed app", () => {
    for (const f of ALL) expect(pushFailureText(f, false)).not.toMatch(/home screen/);
    expect(pushFailureText("unsupported", true)).toMatch(/home screen/);
    expect(pushFailureText("network", true)).not.toMatch(/home screen/);
  });

  it("know an iPhone browser from the installed app", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    expect(iosOutsideApp({ userAgent: ua })).toBe(true);
    expect(iosOutsideApp({ userAgent: ua, standalone: true })).toBe(false);
    expect(iosOutsideApp({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" })).toBe(false);
  });
});
