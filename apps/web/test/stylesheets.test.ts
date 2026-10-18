// SPDX-License-Identifier: AGPL-3.0-or-later
// The stylesheets against the tokens (css.md). Colours are tokens.css's alone, so the contrast test measures every
// one. A transition or a one-shot animation takes its duration and easing from --motion-* and --ease-*, which
// tokens.css zeroes under reduced motion. Looping animations (a spinner, a pulse) are ambient, not a state change,
// and keep their own timing; the landing's terminal card keeps the timings of its own sequence. The landing plays
// its motion once: nothing there loops.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = join(dirname(fileURLToPath(import.meta.url)), "../src/styles");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

/** Every `property: value` declaration in CSS, with its file and line. */
export function declarations(css: string, file = "") {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out: { file: string; line: number; prop: string; value: string }[] = [];
  for (const m of src.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const line = src.slice(0, m.index).split("\n").length + (m[0].match(/^\s*\n/) ? 1 : 0);
    out.push({ file, line, prop: m[1]!, value: m[2]!.replace(/\s+/g, " ").trim() });
  }
  return out;
}

const LITERAL_TIME = /(?<![\w-])\d*\.?\d+m?s\b/;
const KEYWORD_EASING = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear)(?![\w-])/;

/** The declarations that break the motion scale. */
export function offScale(css: string, file = ""): string[] {
  const landing = file.endsWith("landing.css");
  return declarations(css, file)
    .filter(({ prop, value }) => {
      if (value === "none") return false;
      if (prop === "transition") return true;
      return prop === "animation" && !/\binfinite\b/.test(value) && !landing;
    })
    .filter(({ value }) => LITERAL_TIME.test(value) || KEYWORD_EASING.test(value))
    .map(({ file, line, prop, value }) => `${file}:${line} ${prop}: ${value}`);
}

const files = cssFiles(STYLES).map((f) => ({ name: relative(STYLES, f), css: readFileSync(f, "utf8") }));

const COLOUR_LITERAL = /(?<![\w-])(oklch|oklab|lab|lch|rgba?|hsla?|hwb)\(|#[0-9a-f]{3,8}\b/i;

/** The declarations that write a colour instead of naming a token. */
export function colourLiterals(css: string, file = ""): string[] {
  return declarations(css, file)
    .filter(({ value }) => COLOUR_LITERAL.test(value))
    .map(({ file, line, prop, value }) => `${file}:${line} ${prop}: ${value}`);
}

describe("colours", () => {
  it("finds a colour literal and passes a token", () => {
    expect(colourLiterals(".a { color: oklch(0.8 0.03 220); }")).toHaveLength(1);
    expect(colourLiterals(".a { background: color-mix(in oklch, var(--shade) 64%, #333); }")).toHaveLength(1);
    expect(colourLiterals(".a { background: color-mix(in oklch, var(--shade) 64%, var(--hero-term-bg)); }")).toEqual(
      [],
    );
  });

  it("writes colours only in tokens.css", () => {
    expect(files.filter((f) => f.name !== "tokens.css").flatMap((f) => colourLiterals(f.css, f.name))).toEqual([]);
  });
});

describe("motion", () => {
  it("finds a literal duration and a keyword easing, and passes the tokens", () => {
    expect(offScale(".a { transition: transform 0.15s ease; }")).toHaveLength(1);
    expect(offScale(".a { animation: in var(--motion-base) ease-out; }")).toHaveLength(1);
    expect(offScale(".a { transition: opacity var(--motion-fast) var(--ease-standard); }")).toEqual([]);
    expect(offScale(".a { animation: spin 0.7s linear infinite; }")).toEqual([]);
    expect(offScale(".a { transition: none; }")).toEqual([]);
  });

  it("reads the stylesheets", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => declarations(f.css)).filter((d) => d.prop === "transition").length).toBeGreaterThan(5);
  });

  it("takes every transition and one-shot animation from the motion scale", () => {
    expect(files.flatMap((f) => offScale(f.css, f.name))).toEqual([]);
  });

  it("loops nothing on the landing page", () => {
    const landing = files.find((f) => f.name === "surfaces/landing.css");
    expect(landing).toBeDefined();
    const loops = declarations(landing!.css)
      .filter((d) => /^animation(-iteration-count)?$/.test(d.prop) && /\binfinite\b/.test(d.value))
      .map((d) => `${d.line} ${d.prop}: ${d.value}`);
    expect(loops).toEqual([]);
  });
});
