// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { APRS_MESSAGE_MAX, radioLogText } from "../src/log/radioText.js";

const item = (logType: string, comment?: string, extra: Record<string, unknown> = {}) => ({
  cacheId: 1,
  label: "AC-1234",
  queuedAt: 1,
  body: { logType, comment },
  ...extra,
});

describe("the radio fallback text", () => {
  it("is the radio log command for a find, a DNF and a note", () => {
    expect(radioLogText(item("found", "nice  spot\n by the lake"))).toBe("FOUND AC-1234 nice spot by the lake");
    expect(radioLogText(item("found"))).toBe("FOUND AC-1234");
    expect(radioLogText(item("dnf", "muggles"))).toBe("DNF AC-1234 muggles");
    expect(radioLogText(item("note", "log is full"))).toBe("NOTE AC-1234 log is full");
  });
  it("fits one APRS message", () => {
    expect(radioLogText(item("found", "x".repeat(200)))!.length).toBe(APRS_MESSAGE_MAX);
  });
  it("has none where the radio cannot log it", () => {
    expect(radioLogText(item("note"))).toBeNull();
    expect(radioLogText(item("maintenance", "fixed the lid"))).toBeNull();
    expect(radioLogText(item("found", undefined, { label: undefined }))).toBeNull();
    expect(radioLogText(item("unlock", undefined, { kind: "unlock" }))).toBeNull();
  });
});
