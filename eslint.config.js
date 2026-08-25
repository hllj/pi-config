// @ts-check
//
// Flat ESLint config for pi-config (personal pi extensions).
//
// The repo runs under `strict: false` (extensions load via jiti) and mixes
// source, tests, and tools. So this is a pragmatic profile: recommended
// TypeScript rules for real bugs and dead code, but deliberately NOT the
// strict quality gate (`no-explicit-any`, project-aware parsing) that would
// flood errors over the existing tolerant style. See package.json:
//   npm run lint       # check
//   npm run lint:fix   # autofix what's safe
//
import js from "@eslint/js";
import globals from "globals";
import * as tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // monitor/ ships its own deps + tsconfig; subagent/tests run via bash wrappers.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.tsbuildinfo",
      "monitor/**",
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // --- Pragmatic relaxations matching this repo's `strict: false` style ---
      // `any` is used liberally (TypeBox schemas, jiti runtime, loose helpers).
      "@typescript-eslint/no-explicit-any": "off",

      // Legit defensive pattern: `let ok = false; try { ok = check() } catch { ok = false }`.
      "no-useless-assignment": "off",

      // Catch genuinely unused vars/imports; allow `_`-prefixed ignore vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
