import { describe, it, expect } from "vitest";
import { selectCorroboration, shouldAutoPromote, contradictors, type Evidence } from "../src/corroborate.js";

const ev = (instance: string, distanceM: number): Evidence => ({ instance, igateCall: "OE8XXX", distanceM, ts: 1 });

describe("peer auto-promotion (T1.1 reputation)", () => {
  it("promotes an unvetted peer only past the threshold with no contradictions", () => {
    expect(shouldAutoPromote("unvetted", 5, 0, 5)).toBe(true);   // exactly at threshold
    expect(shouldAutoPromote("unvetted", 4, 0, 5)).toBe(false);  // below threshold
    expect(shouldAutoPromote("unvetted", 9, 1, 5)).toBe(false);  // any contradiction blocks it
  });
  it("never promotes trusted/blocked, and is off when the threshold is 0", () => {
    expect(shouldAutoPromote("trusted", 99, 0, 5)).toBe(false);  // already trusted
    expect(shouldAutoPromote("blocked", 99, 0, 5)).toBe(false);  // quarantined stays quarantined
    expect(shouldAutoPromote("unvetted", 99, 0, 0)).toBe(false); // disabled
  });

  it("(T1.1 contradiction signal) debits only peers that DENIED a confirmed corroboration", () => {
    const probes = [
      { url: "https://a", denied: false }, // hit
      { url: "https://b", denied: true },  // explicit "no"
      { url: "https://c", denied: false }, // unavailable (timeout) — not a contradiction
      { url: "https://b", denied: true },  // dup → collapsed
    ];
    expect(contradictors(probes, true)).toEqual(["https://b"]); // only the denier, deduped
    expect(contradictors(probes, false)).toEqual([]);           // no winner → a "no" isn't a contradiction
  });
});

describe("corroboration quorum (F4/T1.2)", () => {
  it("no evidence → null at any quorum", () => {
    expect(selectCorroboration([], 1)).toBeNull();
    expect(selectCorroboration([], 2)).toBeNull();
  });

  it("one instance meets quorum 1 (default) and is returned", () => {
    const r = selectCorroboration([ev("oe.pub", 120)], 1);
    expect(r?.instance).toBe("oe.pub");
    expect(r?.corroborators).toBe(1);
  });

  it("one instance does NOT meet quorum 2 — a single peer cannot mint Tier A", () => {
    expect(selectCorroboration([ev("oe.pub", 50)], 2)).toBeNull();
  });

  it("the same instance answering twice counts as ONE voice (no self-quorum)", () => {
    expect(selectCorroboration([ev("oe.pub", 50), ev("oe.pub", 80)], 2)).toBeNull();
  });

  it("two DISTINCT instances meet quorum 2; closest evidence wins, count annotated", () => {
    const r = selectCorroboration([ev("oe.pub", 200), ev("club.xyz", 75)], 2);
    expect(r?.instance).toBe("club.xyz");
    expect(r?.distanceM).toBe(75);
    expect(r?.corroborators).toBe(2);
  });

  it("quorum floors at 1 (a 0/NaN config never disables the gate)", () => {
    expect(selectCorroboration([ev("oe.pub", 10)], 0)?.instance).toBe("oe.pub");
    expect(selectCorroboration([ev("oe.pub", 10)], Number.NaN)?.instance).toBe("oe.pub");
  });
});
