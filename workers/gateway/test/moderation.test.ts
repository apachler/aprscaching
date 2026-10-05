// SPDX-License-Identifier: AGPL-3.0-or-later
// A refused sign-in names the suspension and its end, and carries no session.
import { describe, it, expect } from "vitest";
import { AccountSuspended, suspendedResponse } from "../src/auth.js";
import { SUSPENDED_TEXT } from "../src/moderation.js";

describe("a suspended sign-in", () => {
  it("says why, and until when", async () => {
    const dated = new AccountSuspended({ reason: "repeated spam", until: Date.UTC(2026, 10, 1) / 1000 });
    expect(dated.message).toBe("this account is suspended on this instance until 2026-11-01: repeated spam");
    const open = new AccountSuspended({ reason: "abuse", until: null });
    expect(open.message).toBe("this account is suspended on this instance: abuse");
    expect(open.message.startsWith(SUSPENDED_TEXT)).toBe(true);
  });

  it("answers 403 with the suspension and no cookie", async () => {
    const r = suspendedResponse(new AccountSuspended({ reason: "abuse", until: null }));
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.json()).toEqual({
      error: "this account is suspended on this instance: abuse",
      suspended: { reason: "abuse", until: null },
    });
  });
});
