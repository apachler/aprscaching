// SPDX-License-Identifier: AGPL-3.0-or-later
// Type-aware ESLint pass — the SLOW gate. Unlike eslint.config.mjs (fast, non-type-aware), this wires
// TypeScript's type information into the linter so it can catch a class of real bugs the fast pass can't:
// floating/misused promises, awaiting non-thenables, unnecessary/contradictory type assertions, etc.
//
// It is deliberately scoped to the trust-critical server + library surface (`workers/gateway/src` and the
// MIT `packages/*/src`) — the code that runs unattended against hostile input — and NOT the web app, which
// leans on DOM `any` and would drown the signal. Run it via `pnpm lint:types`; CI runs it as its own job.
//
// Philosophy mirrors the fast config: the by-design `any` at runtime boundaries (database rows, KISS/AX.25 byte
// shims, protobuf, COSE) means the `no-unsafe-*` / `no-explicit-any` family is OFF — those are not defects
// here. Everything that stays ON is an error, and `pnpm lint:types` runs with `--max-warnings 0`, so a
// warning fails CI too.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "**/*.d.ts", "**/*.test.ts", "**/test/**"],
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
      //     fire on database/KISS/protobuf/COSE shims that are `any` on purpose; they are noise, not defects.
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
      // ERROR: an assertion that changes nothing hides the real type from the reader. `pnpm run check`
      // builds every unit with tsc, so a cast this rule calls redundant but the build needs fails there.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Everything else from recommendedTypeChecked stays at its default (error): the structural,
      // type-view-stable bug catchers — no-floating-promises, no-misused-promises, await-thenable,
      // no-for-in-array, no-redundant-type-constituents, restrict-plus-operands, … .
    },
  },
  {
    // SYNC_DEFS carries a plain data property named `apply` (a standalone applier function, no
    // `this`) — the rule mistakes it for Function.prototype.apply.
    files: ["workers/gateway/src/fedapply.ts"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
);
