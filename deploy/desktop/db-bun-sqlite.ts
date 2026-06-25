// D1-compatible DB adapter backed by Bun's built-in bun:sqlite — no native module.
// Single source of truth: the real, conformance-tested adapter lives in servers/bun/d1.ts
// (run against the tools/smoke suites under Bun in CI). Re-exported here for the single-binary
// desktop build (bun --compile bundles it); `BunD1` kept as an alias for launcher.ts.
export { BunDb, BunDb as BunD1 } from "../../servers/bun/d1.ts";
