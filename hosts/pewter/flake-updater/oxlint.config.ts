import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

// Adapted from the sourdough template: same categories and anti-slop rules,
// minus the React, shadcn and turbo plugins this project has no use for.
export default defineConfig({
  extends: [recommended],
  options: {
    typeAware: true,
    typeCheck: true,
    denyWarnings: true,
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
    pedantic: "warn",
    perf: "error",
    style: "warn",
    restriction: "warn",
    nursery: "off",
  },
  plugins: [
    "unicorn",
    "typescript",
    "oxc",
    "eslint",
    "vitest",
    "node",
    "import",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    // --- anti-slop js plugin preferences ---

    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Maintainers rule aimed at published API stability; this package is private.
    "effecttsgo/api-stability-leak": "off",
    // Same reasoning: dual data-first/data-last overloads serve library
    // consumers piping our functions; nothing outside this package calls them.
    "effecttsgo/missing-pipeable-signature": "off",
    // --- not applicable in codebase ---
    "unicorn/throw-new-error": "off", // Effect errors are values (Schema.TaggedError), never thrown
    "import/named": "off",
    "import/default": "off",
    "import/namespace": "off",
    "eslint/no-undef": "off",
    "oxc/no-async-await": "off",
    "oxc/no-optional-chaining": "off",
    "oxc/no-rest-spread-properties": "off",

    // --- builtin plugin preferences ---

    // oxfmt will sort imports
    // https://github.com/oxc-project/oxc/issues/14253
    // https://github.com/oxc-project/oxc/issues/13610
    "eslint/sort-imports": "off",
    "eslint/max-lines-per-function": "off",
    "eslint/max-lines": "off",
    "eslint/init-declarations": "off",
    "eslint/new-cap": "off",
    "eslint/sort-keys": "off",
    "eslint/func-names": "off",
    "eslint/func-style": "off",
    "eslint/no-magic-numbers": "off",
    "eslint/no-ternary": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-bitwise": "off",
    "eslint/no-void": "off",
    "eslint/class-methods-use-this": "off",
    "eslint/capitalized-comments": "off",
    "eslint/max-statements": "off",
    "eslint/max-classes-per-file": "off",
    "eslint/id-length": "off",
    "eslint/no-undefined": "off",
    "eslint/no-duplicate-imports": [
      "error",
      {
        allowSeparateTypeImports: true,
      },
    ],
    "eslint/no-plusplus": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-promise-executor-return": "off",
    "eslint/no-inline-comments": "off",
    "eslint/no-warning-comments": ["warn", { terms: ["fixme", "xxx"] }],
    "eslint/no-use-before-define": "off",
    "eslint/no-empty-function": "off",
    // one declaration per statement; comma-joined declarations hurt readability
    "eslint/one-var": ["error", "never"],

    "import/no-namespace": "off",
    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "import/exports-last": "off",
    "import/group-exports": "off",
    "import/max-dependencies": "off",
    "import/no-relative-parent-imports": "off",
    "import/no-nodejs-modules": "off",
    "import/no-default-export": "off",
    "import/consistent-type-specifier-style": "off",

    "jest/require-hook": "off",

    "typescript/no-unsafe-type-assertion": "off",
    "typescript/explicit-module-boundary-types": "off",
    "typescript/explicit-function-return-type": "off",
    "typescript/promise-function-async": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/prefer-readonly-parameter-types": "off",

    "unicorn/prefer-ternary": "off",
    "unicorn/no-array-method-this-argument": "off",
    "unicorn/no-array-callback-reference": "off",
    "unicorn/no-null": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/switch-case-braces": "off",
    "unicorn/no-array-reduce": "off",
  },
  overrides: [
    {
      files: ["*.config.ts"],
      rules: {
        "node/no-process-env": "off",
      },
    },
    {
      // CLI entrypoint: the top-level runMain launches the process,
      // it is not test setup code, and it is where layers get provided
      files: ["src/main.ts"],
      rules: {
        "vitest/require-hook": "off",
        "effecttsgo/strict-effect-provide": "off",
      },
    },
    {
      files: ["**/*.test.ts", "test/**/*.ts"],
      rules: {
        // @effect/vitest layer() owns setup and teardown internally
        "vitest/no-importing-vitest-globals": "off",
        // @effect/vitest layer() owns setup and teardown internally
        "vitest/require-hook": "off",
        // Effect-integrated assert replaces expect.hasAssertions.
        "vitest/prefer-expect-assertions": "off",
        "effecttsgo/strict-effect-provide": "off",
        // shared test helpers are plain data functions, so a data-last overload
        // has nothing to dualize
        "effecttsgo/missing-pipeable-signature": "off",
      },
    },
  ],
  settings: {
    vitest: {
      typecheck: false,
    },
  },
  env: {
    builtin: true,
  },
  globals: {},
  ignorePatterns: [
    // The Nix build has no .gitignore, and type-aware linting of
    // node_modules exhausts memory.
    "node_modules/**",
    // agent tooling dirs (installed skills/hooks) and the vendored plugin
    // itself are not application source
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    // captured CI output kept verbatim as test data
    "test/fixtures/**",
  ],
});
