// SPDX-License-Identifier: AGPL-3.0-or-later
// A badge's own hint opens on mouse hover only (the chip is not a control), so a surface that shows a trust tier or a
// verified callsign explains that term with an InfoTip, which opens on tap and keyboard focus too (ui-ux.md §8).
// Read from the source: every file that renders the badge also renders the term's InfoTip.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
/** The primitives and the kit that shows them, and the landing, which explains each tier in its own words. */
const EXEMPT = /^(ui|demo)\/|^Landing\.tsx$/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

const files = tsxFiles(SRC)
  .map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, "utf8") }))
  .filter((f) => !EXEMPT.test(f.rel));

describe.each([
  { badge: "<TierBadge", tip: /<InfoTip\s+text=\{TERMS\.tier\}/ },
  { badge: "<CallVerifiedBadge", tip: /<InfoTip\s+text=\{TERMS\["verified-callsign"\]\}/ },
])("$badge", ({ badge, tip }) => {
  const showing = files.filter((f) => f.src.includes(badge));

  it("is shown somewhere", () => expect(showing.length).toBeGreaterThan(0));

  it("comes with the term's InfoTip on its surface", () =>
    expect(showing.filter((f) => !tip.test(f.src)).map((f) => f.rel)).toEqual([]));
});
