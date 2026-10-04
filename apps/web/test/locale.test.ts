// SPDX-License-Identifier: AGPL-3.0-or-later
// A locale tag the browser or a stored setting supplies always becomes one Intl accepts, so the
// formatters build instead of throwing a RangeError.
import { describe, expect, it } from "vitest";
import { canonicalLocale, makeFormatters, type LocaleSettings } from "../src/format.js";

describe("canonicalLocale", () => {
  const table: [string | undefined | null, string][] = [
    ["de-AT", "de-AT"],
    ["en-us", "en-US"],
    ["en-US@posix", "en-US"],
    ["en_US.UTF-8", "en-US"],
    ["de_AT@euro", "de-AT"],
    ["C", "en-US"],
    ["C.UTF-8", "en-US"],
    ["", "en-US"],
    ["   ", "en-US"],
    [undefined, "en-US"],
    [null, "en-US"],
    ["garbage!!", "en-US"],
    ["@@@", "en-US"],
  ];
  it.each(table)("%j becomes %j", (tag, want) => {
    expect(canonicalLocale(tag)).toBe(want);
  });

  it("returns a tag every Intl formatter accepts", () => {
    for (const [tag] of table) {
      const loc = canonicalLocale(tag);
      expect(() => new Intl.NumberFormat(loc)).not.toThrow();
      expect(() => new Intl.DateTimeFormat(loc)).not.toThrow();
      expect(() => new Intl.RelativeTimeFormat(loc)).not.toThrow();
    }
  });
});

describe("makeFormatters with an unusual locale", () => {
  const base: LocaleSettings = { locale: "", timeZone: "UTC", units: "metric", theme: "dark", crt: false };
  it.each(["en-US@posix", "C", "garbage!!"])("a stored %j override still formats", (locale) => {
    const fmt = makeFormatters({ ...base, locale });
    expect(fmt.resolvedLocale).toBe("en-US");
    expect(fmt.num(1234.5)).toBe("1,234.5");
    expect(fmt.date(0)).toContain("1970");
  });
});
