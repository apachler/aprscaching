// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { missingNotices, packageOf } from "../vite-notices.js";

describe("packageOf", () => {
  it("names the innermost package of a pnpm module path", () => {
    expect(packageOf("/repo/node_modules/.pnpm/react@19.3.0/node_modules/react/index.js")).toBe("react");
    expect(packageOf("/repo/node_modules/.pnpm/a@1/node_modules/@scope/pkg/dist/x.js")).toBe("@scope/pkg");
    expect(packageOf("\0/repo/node_modules/d3-array/src/max.js")).toBe("d3-array");
    expect(packageOf("C:\\repo\\node_modules\\zod\\index.js")).toBe("zod");
  });

  it("returns null for app code and bundler-internal ids", () => {
    expect(packageOf("/repo/apps/web/src/main.tsx")).toBeNull();
    expect(packageOf("\0vite/preload-helper.js")).toBeNull();
  });
});

describe("missingNotices", () => {
  const notices = "react / react-dom\n  d3-array - Copyright\nuPlot\n@chevrotain/gast\n";

  it("accepts a package named as a whole word, in any case", () => {
    expect(missingNotices(["react", "react-dom", "d3-array", "uplot", "@chevrotain/gast"], notices)).toEqual([]);
  });

  it("does not count a package that only appears inside a longer name", () => {
    expect(missingNotices(["d3", "chevrotain", "dom"], notices)).toEqual(["chevrotain", "d3", "dom"]);
  });

  it("skips the workspace's own packages", () => {
    expect(missingNotices(["@aprscaching/aprs"], notices)).toEqual([]);
  });
});
