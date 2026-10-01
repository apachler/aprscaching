// SPDX-License-Identifier: AGPL-3.0-or-later
// WCAG 2.2 contrast of the design tokens' declared foreground/background pairs, in every theme: 4.5:1 for
// text (1.4.3), 3:1 for UI components and graphics (1.4.11). The pairs are the roles the stylesheets give
// the tokens; a pair a stylesheet starts using belongs here too. KNOWN_FAILURES lists pairs that fail
// today and must keep failing until fixed: a fixed pair fails this test until it leaves the list.
import { describe, expect, it } from "vitest";
import { contrast, type Theme } from "./support/tokens";

interface Pair {
  name: string;
  fg: string;
  bg: string;
  /** opaque colour behind a translucent bg */
  behind?: string;
  min: 4.5 | 3;
}

const tint = (base: string, pct: number) => `color-mix(in oklch, var(${base}) ${pct}%, transparent)`;

const PAIRS: Pair[] = [
  { name: "body text on a panel", fg: "var(--ink)", bg: "var(--surface)", min: 4.5 },
  { name: "body text on the page", fg: "var(--ink)", bg: "var(--page-bg)", behind: "var(--page-bg)", min: 4.5 },
  { name: "secondary text on a panel", fg: "var(--muted)", bg: "var(--surface)", min: 4.5 },
  {
    name: "secondary text on a raised control",
    fg: "var(--muted)",
    bg: "var(--surface-2)",
    behind: "var(--surface-2)",
    min: 4.5,
  },
  { name: "secondary text on the rail", fg: "var(--muted)", bg: "var(--rail-bg)", behind: "var(--rail-bg)", min: 4.5 },
  {
    name: "data text on an operator panel",
    fg: "var(--ink-2)",
    bg: "var(--panel-2)",
    behind: "var(--panel-2)",
    min: 4.5,
  },
  { name: "headings and links on a panel", fg: "var(--heading)", bg: "var(--surface)", min: 4.5 },
  { name: "accent as text on a panel", fg: "var(--accent)", bg: "var(--surface)", min: 4.5 },
  { name: "text on the accent (primary button)", fg: "var(--accent-ink)", bg: "var(--accent)", min: 4.5 },
  {
    name: "text on the top bar",
    fg: "var(--chrome-ink)",
    bg: "var(--topbar-bg)",
    behind: "var(--topbar-bg)",
    min: 4.5,
  },
  { name: "Tier A badge", fg: "var(--tier-a)", bg: tint("--tier-a", 20), min: 4.5 },
  { name: "Tier B badge", fg: "var(--tier-b)", bg: tint("--tier-b", 20), min: 4.5 },
  { name: "Tier C badge", fg: "var(--muted)", bg: tint("--tier-c", 16), min: 4.5 },
  { name: "found badge", fg: "var(--ok)", bg: tint("--ok", 20), min: 4.5 },
  { name: "DNF badge", fg: "var(--bad)", bg: tint("--bad", 20), min: 4.5 },
  { name: "warning badge", fg: "var(--warn)", bg: tint("--warn", 20), min: 4.5 },
  { name: "award chip", fg: "var(--award-ink)", bg: "var(--award-bg)", min: 4.5 },
  { name: "letter on a Tier A chip", fg: "var(--ink-tier)", bg: "var(--tier-a)", min: 4.5 },
  { name: "letter on a Tier B chip", fg: "var(--ink-tier)", bg: "var(--tier-b)", min: 4.5 },
  { name: "letter on a Tier C chip", fg: "var(--ink-tier)", bg: "var(--tier-c)", min: 4.5 },
  // MapLibre's control stack is white in every theme
  {
    name: "map control glyph on MapLibre's white",
    fg: "var(--ink-tier)",
    bg: "oklch(1 0 0)",
    behind: "oklch(1 0 0)",
    min: 3,
  },
  { name: "Tier A icon on a panel", fg: "var(--tier-a)", bg: "var(--surface)", min: 3 },
  { name: "Tier B icon on a panel", fg: "var(--tier-b)", bg: "var(--surface)", min: 3 },
  { name: "rail focus ring on the rail", fg: "var(--heading)", bg: "var(--rail-bg)", behind: "var(--rail-bg)", min: 3 },
];

const THEMES: Theme[] = ["dark", "light", "phosphor"];

/** Failing today; each entry leaves this list when the pair is fixed. */
const KNOWN_FAILURES = new Set<string>([
  "dark: DNF badge",
  "light: secondary text on a raised control",
  "light: secondary text on the rail",
  "light: accent as text on a panel",
  "light: text on the accent (primary button)",
  "light: text on the top bar",
  "light: Tier A badge",
  "light: Tier B badge",
  "light: Tier C badge",
  "light: found badge",
  "light: DNF badge",
  "light: warning badge",
  "light: letter on a Tier A chip",
  "light: letter on a Tier B chip",
  "light: letter on a Tier C chip",
  "light: map control glyph on MapLibre's white",
  "light: Tier A icon on a panel",
  "light: Tier B icon on a panel",
]);

describe("token contrast", () => {
  it("measures black on white as 21:1 and a colour on itself as 1:1", () => {
    expect(contrast("dark", "oklch(0 0 0)", "oklch(1 0 0)", "oklch(1 0 0)")).toBeCloseTo(21, 5);
    expect(contrast("light", "var(--accent)", "var(--accent)")).toBeCloseTo(1, 5);
  });

  for (const theme of THEMES) {
    describe(theme, () => {
      for (const p of PAIRS) {
        const id = `${theme}: ${p.name}`;
        it(`${p.name} reaches ${p.min}:1${KNOWN_FAILURES.has(id) ? " (known failure)" : ""}`, () => {
          const ratio = contrast(theme, p.fg, p.bg, p.behind);
          if (KNOWN_FAILURES.has(id)) {
            expect(ratio, `${id} now passes at ${ratio.toFixed(2)}:1 — remove it from KNOWN_FAILURES`).toBeLessThan(
              p.min,
            );
          } else {
            expect(ratio, `${id}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(p.min);
          }
        });
      }
    });
  }

  it("lists only pairs that exist", () => {
    const ids = new Set(THEMES.flatMap((t) => PAIRS.map((p) => `${t}: ${p.name}`)));
    expect([...KNOWN_FAILURES].filter((k) => !ids.has(k))).toEqual([]);
  });
});
