// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { webLink } from "../src/weblink.js";

describe("webLink", () => {
  it("keeps an absolute http(s) address", () => {
    expect(webLink("https://opencaching.de/viewcache.php?wp=OC1234")).toBe(
      "https://opencaching.de/viewcache.php?wp=OC1234",
    );
    expect(webLink("  http://wwff.co/directory/ ")).toBe("http://wwff.co/directory/");
  });
  it("drops any other scheme, a relative path, an oversized string and a non-string", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/cache/1", "ftp://x.test/", "", 42, null])
      expect(webLink(bad)).toBeNull();
    expect(webLink(`https://x.test/${"a".repeat(3000)}`)).toBeNull();
  });
});
