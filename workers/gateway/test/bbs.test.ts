// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { BULLETIN_FEED } from "../src/bbs.js";
import { negotiateFeeds } from "../src/fedpull.js";

describe("BBS bulletin federation (#1)", () => {
  it("BULLETIN_FEED.recordOf carries a stable BID + the bulletin payload", () => {
    const row = {
      id: 7,
      bid: "7_a.example",
      from_call: "OE8APR",
      to_call: "ALL",
      subject: "net",
      body: "Sunday net",
      posted_at: 1000,
      expires_at: 2000,
    };
    const rec = BULLETIN_FEED.recordOf(row, "a.example");
    expect(BULLETIN_FEED.type).toBe("bulletin");
    expect(rec.id).toBe("a.example:bulletin:7"); // the gid lives in the instance's namespace
    expect(rec.cursor).toBe(1000); // posted_at drives the incremental cursor
    expect(rec.data).toMatchObject({
      bid: "7_a.example", // BID = the dedup key across the FBB mesh, carried in the body
      fromCall: "OE8APR",
      toCall: "ALL",
      subject: "net",
      body: "Sunday net",
    });
  });

  it("falls back to an <id>_<instance> BID when a row has none yet", () => {
    expect(
      BULLETIN_FEED.recordOf(
        { id: 9, bid: null, from_call: "X", to_call: "ALL", subject: null, body: "hi", posted_at: 5, expires_at: null },
        "b.example",
      ).data,
    ).toMatchObject({ bid: "9_b.example" });
  });

  it("a capability-advertising peer must list 'bulletins' for it to be pulled", () => {
    const defs = [{ capability: "caches" }, { capability: "bulletins" }];
    // legacy peer (no protocol match) → try everything
    expect(negotiateFeeds({}, defs, "0.2").map((d) => d.capability)).toEqual(["caches", "bulletins"]);
    // negotiated peer that omits bulletins → skip it
    expect(
      negotiateFeeds({ protocolVersions: ["0.2"], capabilities: ["caches"] }, defs, "0.2").map((d) => d.capability),
    ).toEqual(["caches"]);
    // negotiated peer that advertises bulletins → include it
    expect(
      negotiateFeeds({ protocolVersions: ["0.2"], capabilities: ["caches", "bulletins"] }, defs, "0.2").map(
        (d) => d.capability,
      ),
    ).toEqual(["caches", "bulletins"]);
  });
});
