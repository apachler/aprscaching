// SPDX-License-Identifier: AGPL-3.0-or-later
// Flat ESLint config — deliberately light. Formatting is Prettier's job (eslint-config-prettier turns
// the stylistic rules off), so these rules target real correctness/foot-guns only. Non-type-aware
// (fast, no per-package project wiring); tighten rule-by-rule over time (see TODO.md).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**", // generated worker dev bundles
      "site/**",
      "coverage/**",
      "**/*.d.ts",
      "**/data/**",
      "tools/teaser/**", // vendored playwright + generated assets
      "apps/web/public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Files span browser / worker / node / bun — allow the union of globals rather than wiring
      // per-directory environments for a non-type-aware pass.
      globals: { ...globals.browser, ...globals.node, ...globals.worker, ...globals.serviceworker },
    },
    rules: {
      // The codebase deliberately uses `any` at runtime boundaries (D1/KISS/protobuf shims, DTOs).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // Unused vars are worth surfacing but shouldn't block CI; `_`-prefixed are intentional.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // TypeScript already resolves identifiers; `no-undef` only produces false positives here
      // (Cloudflare Worker globals like WebSocketPair, DOM/Node union, etc.).
      "no-undef": "off",
      // Control chars appear legitimately in ANSI/AFSK/KISS parsing regexes.
      "no-control-regex": "off",
      // `while (n--)` style guards are used intentionally in the pure state machines.
      "no-constant-condition": ["error", { checkLoops: false }],
      // --- stylistic / cleanup: surfaced as warnings so they don't block CI at the 1.0 baseline;
      //     tighten to error over time (TODO.md). Genuinely-dangerous rules stay errors above.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      // ESLint-10 additions — useful but noisy on intentional resets / rethrows; warn at baseline.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },
  // React app: register the hooks plugin so rules-of-hooks catches real bugs and the existing
  // `// eslint-disable-next-line react-hooks/exhaustive-deps` directives resolve to a known rule.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Test files and Node scripts: relax a couple more.
  {
    files: ["**/*.test.ts", "**/test/**", "tools/**/*.mjs", "**/*.config.*"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  prettier,
);
