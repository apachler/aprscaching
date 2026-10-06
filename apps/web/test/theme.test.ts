// SPDX-License-Identifier: AGPL-3.0-or-later
// The Appearance setting: how a stored value becomes a theme, how a theme resolves against the system's
// colour scheme (and follows it live under "auto"), and that index.html's first-paint script and
// theme-color metas agree with the tokens and with format.ts.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { normalizeTheme, resolveTheme, type Theme } from "../src/format.js";
import { oklchToRgb, parseColor, themeTokens } from "./support/tokens";

const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");

describe("normalizeTheme", () => {
  const table: [unknown, Theme][] = [
    ["dark", "dark"],
    ["light", "light"],
    ["auto", "auto"],
    ["phosphor", "phosphor"],
    ["sepia", "dark"],
    ["", "dark"],
    [undefined, "dark"],
    [null, "dark"],
    [42, "dark"],
    [{ theme: "light" }, "dark"],
  ];
  for (const [stored, want] of table)
    it(`${JSON.stringify(stored)} → ${want}`, () => expect(normalizeTheme(stored)).toBe(want));
});

describe("resolveTheme", () => {
  it("auto follows the system", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
  it("an explicit theme ignores the system", () => {
    for (const dark of [true, false]) {
      expect(resolveTheme("dark", dark)).toBe("dark");
      expect(resolveTheme("light", dark)).toBe("light");
      expect(resolveTheme("phosphor", dark)).toBe("phosphor");
    }
  });
});

describe("watchSystemTheme", () => {
  /** A stand-in matchMedia whose light/dark answer the test flips. */
  function fakeMedia(light: boolean) {
    const listeners = new Set<() => void>();
    const state = { light };
    const mm = (q: string) => ({
      get matches() {
        return q.includes("light") ? state.light : !state.light;
      },
      addEventListener: (_: "change", fn: () => void) => listeners.add(fn),
      removeEventListener: (_: "change", fn: () => void) => listeners.delete(fn),
    });
    return { mm, flip: (l: boolean) => ((state.light = l), listeners.forEach((f) => f())), listeners };
  }
  const doc = () => {
    const root = { dataset: {} as Record<string, string> };
    (globalThis as { document?: unknown }).document = { documentElement: root, body: null, querySelectorAll: () => [] };
    return root;
  };
  const settings = (theme: Theme) => ({ locale: "", timeZone: "", units: "metric" as const, theme, crt: false });

  it("re-applies auto when the system changes, and stops when unsubscribed", async () => {
    const { applyTheme, watchSystemTheme } = await import("../src/shell/theme.js");
    const root = doc();
    const media = fakeMedia(true);
    expect(applyTheme(settings("auto"), media.mm)).toBe("light");
    const stop = watchSystemTheme(settings("auto"), media.mm);
    media.flip(true);
    expect(root.dataset.theme).toBe("light");
    media.flip(false);
    expect(root.dataset.theme).toBe("dark");
    stop();
    expect(media.listeners.size).toBe(0);
  });

  it("does not watch an explicit theme", async () => {
    const { watchSystemTheme } = await import("../src/shell/theme.js");
    doc();
    const media = fakeMedia(true);
    watchSystemTheme(settings("light"), media.mm);
    expect(media.listeners.size).toBe(0);
  });
});

describe("index.html", () => {
  const hex = (theme: "dark" | "light", token: string) => {
    const c = oklchToRgb(parseColor(`var(${token})`, themeTokens(theme)));
    return `#${[c.r, c.g, c.b]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  };

  it("carries a theme-color for each system scheme, equal to that theme's top bar", () => {
    const metas = [
      ...INDEX.matchAll(
        /<meta name="theme-color" media="\(prefers-color-scheme: (dark|light)\)" content="(#[0-9a-f]{6})" \/>/g,
      ),
    ];
    expect(metas.map((m) => m[1]).sort()).toEqual(["dark", "light"]);
    for (const [, scheme, content] of metas) {
      expect(content, `${scheme}: set it to ${hex(scheme as "dark" | "light", "--topbar-bg")}`).toBe(
        hex(scheme as "dark" | "light", "--topbar-bg"),
      );
    }
  });

  it("applies the same theme before the first paint as format.ts does", () => {
    const script = /<script>\s*([\s\S]*?\bacs\.locale[\s\S]*?)<\/script>/.exec(INDEX)?.[1];
    expect(script, "index.html has no first-paint theme script").toBeTruthy();
    const stored: unknown[] = ["dark", "light", "auto", "phosphor", "nonsense", undefined];
    for (const value of stored) {
      for (const prefersDark of [true, false]) {
        const root = { dataset: {} as Record<string, string> };
        runInNewContext(script as string, {
          document: { documentElement: root },
          localStorage: { getItem: () => (value === undefined ? null : JSON.stringify({ theme: value })) },
          matchMedia: (q: string) => ({ matches: q.includes("light") ? !prefersDark : prefersDark }),
        });
        expect(root.dataset.theme, `stored ${String(value)}, system ${prefersDark ? "dark" : "light"}`).toBe(
          resolveTheme(normalizeTheme(value), prefersDark),
        );
      }
    }
  });
});
