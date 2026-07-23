// SPDX-License-Identifier: AGPL-3.0-or-later
// Type-aware ESLint pass — the SLOW gate. Unlike eslint.config.mjs (fast, non-type-aware), this wires
// TypeScript's type information into the linter so it can catch a class of real bugs the fast pass can't:
// floating/misused promises, awaiting non-thenables, unnecessary/contradictory type assertions, etc.
//
// It is deliberately scoped to the trust-critical server + library surface (`workers/gateway/src` and the
// MIT `packages/*/src`) — the code that runs unattended against hostile input — and NOT the web app, which
// leans on DOM `any` and would drown the signal. Run it via `pnpm lint:types`; CI runs it as its own job.
//
// Philosophy mirrors the fast config: the by-design `any` at runtime boundaries (D1 rows, KISS/AX.25 byte
// shims, protobuf, COSE) means the `no-unsafe-*` / `no-explicit-any` family is OFF — those are not defects
// here. What stays ON (error) is the bug-catching set that is genuinely green today; softer stylistic
// type-aware rules are warnings to tighten over time (see TODO.md).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "**/*.d.ts", "**/*.test.ts", "**/test/**"],
  },
  {
    files: ["workers/gateway/src/**/*.ts", "packages/*/src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Auto-discover each package's tsconfig — no per-directory wiring needed (typescript-eslint v8+).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- OFF: by-design `any` at runtime boundaries (kept consistent with the fast config). These
      //     fire on D1/KISS/protobuf/COSE shims that are `any` on purpose; they are noise, not defects.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // The fast config already owns unused-vars/expressions + the core stylistic rules; don't
      // double-report here — this pass is only about the type-aware findings.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "prefer-const": "off",

      // ERROR: an untrusted value must not stringify to "[object Object]". Request-body fields are
      // coerced through `asStr()` (gateway) / a local equivalent (packages/tools) at every boundary.
      "@typescript-eslint/no-base-to-string": "error",
      // ERROR: template literals only interpolate string-ish values — no accidental object stringification.
      "@typescript-eslint/restrict-template-expressions": "error",
      // ERROR: an accidental async-without-await or an unbound method reference is a real defect. The
      // few legitimate exceptions are exempted per-file below (inline disables would read as "unused
      // directives" to the fast config, which doesn't enable these rules).
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/unbound-method": "error",
      // `Response.json()` and friends default their generic to `unknown`, and the linter's projectService
      // view of that default disagrees with the build's — so this rule flags necessary assertions as
      // "unnecessary". Left as a WARN (never auto-fixed in CI) so it can't remove a load-bearing cast.
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",

      // Everything else from recommendedTypeChecked stays at its default (error): the structural,
      // type-view-stable bug catchers — no-floating-promises, no-misused-promises, await-thenable,
      // no-for-in-array, no-redundant-type-constituents, restrict-plus-operands, … .
    },
  },
  {
    // The Durable Object hibernation API mandates async webSocketMessage/Close/Error signatures;
    // the handler bodies are synchronous by design.
    files: ["workers/gateway/src/room.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // SYNC_DEFS carries a plain data property named `apply` (a standalone applier function, no
    // `this`) — the rule mistakes it for Function.prototype.apply.
    files: ["workers/gateway/src/federation_sync.ts"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
);
