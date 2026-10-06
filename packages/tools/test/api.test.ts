// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { TOOL_API, TOOL_API_VERSION, parseToolApi, toolApiProblem, validateManifest } from "../src/index.js";

describe("the tool API version", () => {
  it("is 1.0", () => {
    expect(TOOL_API).toEqual({ major: 1, minor: 0 });
    expect(TOOL_API_VERSION).toBe("1.0");
  });

  it("parses MAJOR.MINOR only", () => {
    expect(parseToolApi("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseToolApi("2.13")).toEqual({ major: 2, minor: 13 });
    for (const bad of [undefined, 1, "1", "1.0.0", "v1.0", "01.0", "1.x", " 1.0", ""])
      expect(parseToolApi(bad)).toBeNull();
  });

  it("runs the same major at the same or a lower minor, and refuses the rest", () => {
    expect(toolApiProblem("1.0")).toBeNull();
    expect(toolApiProblem("1.0", { major: 1, minor: 2 })).toBeNull();
    expect(toolApiProblem("1.1")).toBe("it needs tool API 1.1; this instance implements 1.0");
    expect(toolApiProblem("2.0")).toBe("it needs tool API 2.0; this instance implements 1.0");
    expect(toolApiProblem("0.9")).toMatch(/needs tool API 0.9/);
    expect(toolApiProblem(undefined)).toMatch(/names no tool API version/);
  });

  it("is required by the manifest validator", () => {
    const base = { name: "t-tool", title: "T", author: "X", version: "1", permissions: [] };
    expect(validateManifest(base)).toEqual({ ok: false, error: expect.stringMatching(/^api must name/) });
    expect(validateManifest({ ...base, api: "1" }).ok).toBe(false);
    const ok = validateManifest({ ...base, api: "1.0" });
    expect(ok.ok && ok.manifest.api).toBe("1.0");
  });
});
