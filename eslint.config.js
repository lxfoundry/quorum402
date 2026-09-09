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
 *
 * `scripts/` gets one of them anyway, for the reason at the bottom of this file.
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
  {
    /**
     * The demo page runs in a browser, not in Node.
     *
     * It is plain JavaScript on purpose - no bundler, no build step, nothing to go wrong between
     * saving a file and reloading a tab - so it is linted here rather than compiled anywhere.
     * Without this it is checked against Node's globals and every `document` is an undefined
     * variable.
     */
    files: ["public/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    /**
     * One type-aware rule, for `scripts/` only.
     *
     * The blanket reasoning above holds - `tsc` catches most of what these rules would, a step
     * earlier and faster. This one is the exception because it catches something `tsc` cannot
     * object to: testing an always-present value for truthiness is perfectly well typed, and
     * silently always true. A function that widens its return type from `T | undefined` to an
     * object leaves every `if (result)` behind it reading as a check and behaving as a
     * straight line.
     *
     * `scripts/` is where that goes unnoticed. It is the only directory with no tests, and its
     * callers are the last thing a change to `src/` is checked against - so the compiler, the
     * suite and the reviewer's diff all miss the same defect in the same place. That is not
     * hypothetical: it is exactly how the demo command came to redeem against the wrong pool
     * and report a good seat as unindexed.
     *
     * Costs about six seconds, and only when `scripts/` is linted.
     */
    files: ["scripts/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/no-unnecessary-condition": "error" },
  },
);
