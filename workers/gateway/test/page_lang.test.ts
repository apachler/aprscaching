// SPDX-License-Identifier: AGPL-3.0-or-later
// Every page the gateway renders declares its language, so a screen reader reads the English text with an
// English voice (WCAG 3.1.1).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("server-rendered pages", () => {
  it("open with <html lang> right after the doctype", () => {
    const pages = sources(SRC).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<!doctype html>(.{0,20})/gi)].map((m) => ({ f, after: m[1]! })),
    );
    expect(pages.length).toBeGreaterThan(4);
    const bare = pages.filter((p) => !/^\s*<html lang=/i.test(p.after)).map((p) => p.f.slice(SRC.length + 1));
    expect(bare).toEqual([]);
  });
});
