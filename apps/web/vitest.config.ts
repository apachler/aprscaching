// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// The web app's unit suite covers its pure logic modules (data-loading and polling state, the surface/navigation
// table, the overlay model, the encoding helpers), source scans read with the TypeScript parser, and component
// and hook tests that render under jsdom (a `@vitest-environment jsdom` header): state that must hold across
// re-renders, and accessibility checked with axe-core (`*.test.tsx`).
export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
