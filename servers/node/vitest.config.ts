// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Every suite here runs real gateways over SQLite, all on the CPU: a test that takes 150 ms alone takes
// several seconds on a machine whose cores other suites share, past vitest's 5 s default. A test that
// genuinely hangs still fails; the slowest suites set a longer budget of their own.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
