// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, parsePage, keyset, paginate } from "../src/paging.js";

describe("paging — keyset cursor (docs/11)", () => {
  it("round-trips a cursor through opaque base64url", () => {
    const c = { primary: 1719600000, id: 4242 };
    const enc = encodeCursor(c);
    expect(enc).not.toContain(":");      // opaque, not the raw "ts:id"
    expect(decodeCursor(enc)).toEqual(c);
  });

  it("rejects a malformed cursor as null (first page)", () => {
    expect(decodeCursor("not-base64-$$$")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("parses + clamps limit and reads the cursor", () => {
    const u = new URL(`http://x/api/activity?limit=500&cursor=${encodeCursor({ primary: 9, id: 3 })}`);
    const pg = parsePage(u, 25, 100);
    expect(pg.limit).toBe(100);                 // clamped to max
    expect(pg.cursor).toEqual({ primary: 9, id: 3 });
    expect(parsePage(new URL("http://x/api/activity")).limit).toBe(25); // default
    expect(parsePage(new URL("http://x/api/activity?limit=0"), 25).limit).toBe(25); // 0 → default, then ≥1
  });

  it("emits an empty keyset clause on the first page, a composite tie-safe clause after", () => {
    expect(keyset(null, "l.ts", "l.id")).toEqual({ sql: "", binds: [] });
    const ks = keyset({ primary: 100, id: 7 }, "l.ts", "l.id");
    expect(ks.sql).toBe(" AND (l.ts < ? OR (l.ts = ? AND l.id < ?))");
    expect(ks.binds).toEqual([100, 100, 7]);
  });

  it("paginate: slices limit+1 rows and derives nextCursor from the last kept row", () => {
    const rows = [{ ts: 30, id: 3 }, { ts: 20, id: 2 }, { ts: 10, id: 1 }]; // fetched limit(2)+1
    const page = paginate(rows, 2, (r) => ({ primary: r.ts, id: r.id }));
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor)).toEqual({ primary: 20, id: 2 });
  });

  it("paginate: last page has no cursor", () => {
    const page = paginate([{ ts: 10, id: 1 }], 2, (r) => ({ primary: r.ts, id: r.id }));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
