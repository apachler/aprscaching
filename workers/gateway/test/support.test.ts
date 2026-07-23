// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { summarizeLedger } from "../src/support.js";

const T = (ym: string) => Math.floor(Date.parse(`${ym}T00:00:00Z`) / 1000);

describe("support — ledger summary", () => {
  it("totals in/out, balance, per-bucket and monthly series", () => {
    const s = summarizeLedger([
      { ts: T("2026-05-10"), direction: "in", bucket: "development", amount_cents: 5000, currency: "EUR" },
      { ts: T("2026-05-20"), direction: "in", bucket: "hosting", amount_cents: 2000 },
      { ts: T("2026-06-01"), direction: "out", bucket: "hosting", amount_cents: 1500 },
    ]);
    expect(s.totalInCents).toBe(7000);
    expect(s.totalOutCents).toBe(1500);
    expect(s.balanceCents).toBe(5500);
    expect(s.buckets.hosting).toEqual({ inCents: 2000, outCents: 1500 });
    expect(s.buckets.development.inCents).toBe(5000);
    expect(s.months).toEqual([
      { month: "2026-05", inCents: 7000, outCents: 0 },
      { month: "2026-06", inCents: 0, outCents: 1500 },
    ]);
  });

  it("ignores unknown buckets in the per-bucket tally but still counts the totals", () => {
    const s = summarizeLedger([{ ts: T("2026-06-01"), direction: "in", bucket: "bogus", amount_cents: 900 }]);
    expect(s.totalInCents).toBe(900);
    expect(s.buckets.development.inCents).toBe(0);
  });

  it("an empty ledger summarizes to zeros", () => {
    const s = summarizeLedger([]);
    expect(s).toMatchObject({ totalInCents: 0, totalOutCents: 0, balanceCents: 0, months: [] });
  });
});
