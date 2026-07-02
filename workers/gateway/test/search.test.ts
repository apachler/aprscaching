// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { likeEscape } from "../src/search.js";

describe("search — LIKE-wildcard escaping (docs/11 M2)", () => {
  it("neutralizes % and _ so they match literally, not as wildcards", () => {
    expect(likeEscape("100%")).toBe("100\\%");
    expect(likeEscape("a_b")).toBe("a\\_b");
    expect(likeEscape("OE8APR")).toBe("OE8APR"); // ordinary text is untouched
  });

  it("escapes a literal backslash first so the escape char itself can be searched", () => {
    expect(likeEscape("a\\b")).toBe("a\\\\b");
    expect(likeEscape("%_\\")).toBe("\\%\\_\\\\");
  });
});
