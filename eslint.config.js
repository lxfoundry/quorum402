import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Lint is a second opinion, not a style police force: `typecheck` already runs the compiler
 * over the same files, so the rules kept here are the ones a type checker does not have -
 * unused bindings, unreachable code, a `case` that falls through by accident.
 *
 * The type-aware rule sets are deliberately not enabled. They need the TypeScript program
 * built for every run, which is the slowest thing in CI, and what they would catch is
 * mostly what `tsc --noEmit` already catches a step earlier.
 */
export default tseslint.config(
  {
    ignores: [
      // Build output. `artifacts/` holds generated contract types, not ours to lint.
      "artifacts/",
      "cache/",
      "dist/",
      // Vendored third-party library, committed on purpose and never modified - see
      // CLAUDE.md and `.claude/skills/VENDORED.md`.
      ".claude/",
      // The subgraph mappings are AssemblyScript, not TypeScript. They share the extension
      // and nothing else - `i32` is a type there and a syntax error here - and `graph build`
      // is the compiler that has an opinion about them.
      "subgraph/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // A leading underscore marks a binding that is deliberately unused - a positional
      // argument kept for shape, a destructured field skipped on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
