// SPDX-License-Identifier: AGPL-3.0-or-later
// `pnpm run coverage`: every unit's vitest suite in one run, with V8 line and branch coverage over the source
// it tests. Each unit keeps its own config (apps/web's) or vitest's defaults. Reports land in coverage/:
// html for reading, lcov for tools, json-summary for the totals. No threshold: the number is measured, not gated.
import { defineConfig } from "vitest/config";

const units = ["packages/aprs", "packages/ax25", "packages/packet", "packages/shared", "packages/tools"];
const apps = ["workers/gateway", "servers/node", "apps/ingest", "apps/web"];

export default defineConfig({
  test: {
    projects: [...units, ...apps],
    coverage: {
      provider: "v8",
      include: [...units, ...apps].map((u) => `${u}/src/**/*.{ts,tsx,js,mjs}`),
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
