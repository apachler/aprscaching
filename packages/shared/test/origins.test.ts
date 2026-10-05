// SPDX-License-Identifier: MIT
// EXTRA_ORIGINS holds bare http(s) origins: the parser normalises and de-duplicates them, and the config check
// refuses anything with a path, a query, credentials or another scheme.
import { describe, it, expect } from "vitest";
import { parseOriginList } from "../src/origins.js";
import { validateConfig } from "../src/config.js";

describe("parseOriginList", () => {
  it("takes https and http origins, names or IPv4 addresses, separated by commas or spaces", () => {
    expect(
      parseOriginList(
        "https://Aprscaching.OE8APR.ampr.org/, http://aprscaching.oe8xyz.hamnet.example  http://44.143.1.2:8080",
      ),
    ).toEqual({
      origins: [
        "https://aprscaching.oe8apr.ampr.org",
        "http://aprscaching.oe8xyz.hamnet.example",
        "http://44.143.1.2:8080",
      ],
      invalid: [],
    });
  });

  it("keeps the first of two spellings of one origin, and drops the default port", () => {
    expect(parseOriginList("https://a.example:443,https://a.example").origins).toEqual(["https://a.example"]);
  });

  it("names every entry that is not a bare http(s) origin", () => {
    expect(
      parseOriginList("https://a.example/app,ftp://b.example,c.example,https://u:p@d.example,http://e.example?x=1")
        .invalid,
    ).toHaveLength(5);
    expect(parseOriginList(undefined)).toEqual({ origins: [], invalid: [] });
  });

  it("is what the config check holds EXTRA_ORIGINS to", () => {
    expect(validateConfig({ EXTRA_ORIGINS: "https://a.example, http://44.143.1.2" }, "gateway")).toEqual([]);
    expect(validateConfig({ EXTRA_ORIGINS: "https://a.example/path" }, "gateway").map((p) => p.key)).toEqual([
      "EXTRA_ORIGINS",
    ]);
  });
});
