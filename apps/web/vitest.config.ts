// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// The web app's unit suite covers its pure logic modules (no DOM): data-loading and polling state,
// the surface/navigation table, the overlay model, and the encoding helpers. A few files opt into jsdom
// (`@vitest-environment jsdom`) to render a component or hook whose state must hold across re-renders.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
