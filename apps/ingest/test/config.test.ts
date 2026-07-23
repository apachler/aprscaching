// SPDX-License-Identifier: AGPL-3.0-or-later
// Numeric env validation (a blank BATCH_MS must NOT become a 1 ms loop / port 0) and the dotenv
// loader the documented `pnpm dev`/`start` paths rely on.
import { describe, it, expect, afterEach } from "vitest";
import { numEnv, portEnv, loadDotEnv } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("numEnv validates + floors", () => {
  it("a blank value falls back to the default (not 0)", () => {
    process.env.T_BATCH = "";
    expect(numEnv("T_BATCH", 1500, { min: 100 })).toBe(1500);
  });
  it("a missing value falls back to the default", () => {
    delete process.env.T_MISSING;
    expect(numEnv("T_MISSING", 42)).toBe(42);
  });
  it("a non-numeric value falls back to the default", () => {
    process.env.T_BAD = "abc";
    expect(numEnv("T_BAD", 7)).toBe(7);
  });
  it("clamps to the configured min/max", () => {
    process.env.T_LOW = "5";
    expect(numEnv("T_LOW", 1500, { min: 100 })).toBe(100);
    process.env.T_HIGH = "999999";
    expect(numEnv("T_HIGH", 100, { max: 500 })).toBe(500);
  });
  it("passes a valid value through", () => {
    process.env.T_OK = "2500";
    expect(numEnv("T_OK", 1500, { min: 100 })).toBe(2500);
  });
  it("portEnv rejects out-of-range ports", () => {
    process.env.T_PORT = "";
    expect(portEnv("T_PORT", 14580)).toBe(14580); // blank → default, never 0
    process.env.T_PORT = "70000";
    expect(portEnv("T_PORT", 14580)).toBe(65535); // clamped into range
  });
});

describe("loadDotEnv", () => {
  it("loads KEY=VALUE lines without overwriting existing env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acfg-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(
      file,
      ["# a comment", "APRSIS_CALLSIGN=OE8APR", "", 'FILTER="r/47/15/300"', "PRESET=fromfile"].join("\n"),
    );
    process.env.PRESET = "fromshell"; // real env must win
    delete process.env.APRSIS_CALLSIGN;
    loadDotEnv(file);
    expect(process.env.APRSIS_CALLSIGN).toBe("OE8APR");
    expect(process.env.FILTER).toBe("r/47/15/300"); // quotes stripped
    expect(process.env.PRESET).toBe("fromshell"); // not overwritten
  });
  it("is a no-op when the file is absent", () => {
    expect(() => loadDotEnv("/nonexistent/.env")).not.toThrow();
  });
});
