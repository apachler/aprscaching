// SPDX-License-Identifier: AGPL-3.0-or-later
// What the app tells a person about their own account: why a session ended, when the account has no way back
// in and how long Later holds that question off, where a sign-in from a cache returns to, and how each kind of
// alert is labelled.
import { describe, it, expect } from "vitest";
import {
  RECOVERY_LATER_MS,
  endedNotice,
  needsRecovery,
  recoveryLaterHolds,
  rememberRecoveryLater,
  rememberReturn,
  takeReturn,
} from "../src/identity/accountNotices.js";
import { alertKindView } from "../src/shack/alertKinds.js";

const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

describe("a session that ended", () => {
  it("says until when and why a suspension holds, and offers nothing else", () => {
    const n = endedNotice({ reason: "suspended", until: 1_791_763_200, why: "Spam reports." }, day);
    expect(n.body).toContain("suspended until 2026-10-12: Spam reports. While");
    expect(n.action).toBeNull();
    expect(endedNotice({ reason: "suspended", until: null, why: "abuse" }, day).body).toContain(
      "until the sysop lifts it: abuse.",
    );
  });

  it("offers the data to an account left with no callsign, and a sign-in to one with others", () => {
    const callless = endedNotice(
      { reason: "released", callsign: "OE6BOB", by: "licensee", note: null, callless: true },
      day,
    );
    expect(callless.body).toMatch(/^Your callsign OE6BOB was taken over by its verified holder\./);
    expect(callless.action).toBe("data");
    const others = endedNotice(
      { reason: "released", callsign: "OE6BOB", by: "sysop", note: "licence belongs to someone else", callless: false },
      day,
    );
    expect(others.body).toMatch(/^The sysop released your callsign OE6BOB from your account: licence belongs/);
    expect(others.action).toBe("signin");
  });
  it("confirms an erasure the person asked for, and offers nothing else", () => {
    const n = endedNotice({ reason: "erased" }, day);
    expect(n.title).toBe("Your account is erased");
    expect(n.action).toBeNull();
  });
});

describe("an account with no way back in", () => {
  const base = { signedIn: true, offline: false, passkeys: 0, email: null };
  it("is one with no passkey and no confirmed email", () => {
    expect(needsRecovery(base)).toBe(true);
    expect(needsRecovery({ ...base, passkeys: 1 })).toBe(false);
    expect(needsRecovery({ ...base, email: "a@b.c" })).toBe(false);
  });
  it("is not asked about while signed out, offline, or when the count is unknown", () => {
    expect(needsRecovery({ ...base, signedIn: false })).toBe(false);
    expect(needsRecovery({ ...base, offline: true })).toBe(false);
    expect(needsRecovery({ ...base, passkeys: undefined })).toBe(false);
  });
  it("is asked again once Later has held for its time, per account on this device", () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
    expect(recoveryLaterHolds(s, "OE6ABC", 1_000)).toBe(false);
    rememberRecoveryLater(s, "oe6abc", 1_000);
    expect(recoveryLaterHolds(s, "OE6ABC", 2_000)).toBe(true);
    expect(recoveryLaterHolds(s, "OE6XYZ", 2_000)).toBe(false);
    expect(recoveryLaterHolds(s, "OE6ABC", 1_000 + RECOVERY_LATER_MS)).toBe(false);
    const refusing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    expect(() => rememberRecoveryLater(refusing, "OE6ABC")).not.toThrow();
    expect(recoveryLaterHolds(refusing, "OE6ABC")).toBe(false);
  });
});

describe("a sign-in from a cache", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  it("returns to the cache once, within half an hour", () => {
    const s = memory();
    rememberReturn(s, 42, 1_000);
    expect(takeReturn(s, 2_000)).toBe(42);
    expect(takeReturn(s, 2_000)).toBeNull();
    rememberReturn(s, 7, 0);
    expect(takeReturn(s, 31 * 60_000)).toBeNull();
  });
  it("survives storage that refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    expect(() => rememberReturn(refusing, 1)).not.toThrow();
    expect(takeReturn(refusing)).toBeNull();
  });
});

describe("alert labels", () => {
  it("labels a sysop's notice as one, never as a heard station", () => {
    expect(alertKindView("removed").label).toBe("Removed by the sysop");
    expect(alertKindView("heard").label).toBe("heard");
    expect(alertKindView("something-new").label).toBe("Notice");
  });
});
