import { recommended } from "@effect/tsgo/oxlint-presets";
import nkzw from "@nkzw/oxlint-config/with-sorting";
import { defineConfig } from "oxlint";

const MANUAL_EFFECT_RUNNER_MESSAGE =
  "Write the test with `it.effect(...)` or `layer(...)(...)` from `@effect/vitest`.";

// What OpenCode lets the Kiro plugin import at runtime, as gitignore-style
// exceptions to a "*" pattern.
const KIRO_RUNTIME_IMPORTS = [
  "!effect",
  "!effect/**",
  "!@opencode/plugin",
  "!@opencode/plugin/**",
  "!bun:*",
  "!node:*",
  "!node:*/*",
  "!./*",
];

// Adapted from the sourdough template: same categories and presets, minus the
// React, shadcn and turbo plugins this repo has no use for. It lints the Bun
// workspace packages listed in package.json.
export default defineConfig({
  categories: {
    correctness: "error",
    nursery: "off",
    pedantic: "warn",
    perf: "error",
    restriction: "warn",
    style: "warn",
    suspicious: "warn",
  },
  env: {
    builtin: true,
  },
  extends: [recommended, nkzw],
  globals: {},
  ignorePatterns: [
    // The Nix build has no .gitignore, and type-aware linting of
    // node_modules exhausts memory.
    "**/node_modules/**",
    // agent tooling dirs (installed skills/hooks) are not application source
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
    // captured CI and API output kept verbatim as test data
    "**/test/fixtures/**",
    // build output
    "**/dist/**",
    // ~/.agents submodule
    "modules/llm/.agents/**",
  ],
  options: {
    denyWarnings: true,
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ["**/*.config.ts"],
      rules: {
        "node/no-process-env": "off",
      },
    },
    {
      // tool config files are plain data; native array methods are fine
      files: ["*.config.ts"],
      rules: {
        "effecttsgo/prefer-effect-array": "off",
      },
    },
    {
      // CLI entrypoints and build tools: the top-level runMain launches the process,
      // it is not test setup code, and it is where layers get provided
      files: ["**/src/main.ts", "**/tools/*.ts"],
      rules: {
        "effecttsgo/strict-effect-provide": "off",
        "vitest/require-hook": "off",
      },
    },
    {
      // Effect.run* and ManagedRuntime.make skip the test runtime's scope,
      // TestClock and layer cleanup; tests use it.effect or layer() from
      // @effect/vitest instead
      files: ["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...[
            "runCallback",
            "runCallbackWith",
            "runFork",
            "runForkWith",
            "runPromise",
            "runPromiseExit",
            "runPromiseExitWith",
            "runPromiseWith",
            "runSync",
            "runSyncExit",
            "runSyncExitWith",
            "runSyncWith",
          ].map((property) => ({
            message: MANUAL_EFFECT_RUNNER_MESSAGE,
            object: "Effect",
            property,
          })),
          {
            message: MANUAL_EFFECT_RUNNER_MESSAGE,
            object: "ManagedRuntime",
            property: "make",
          },
        ],
      },
    },
    {
      files: ["**/*.test.ts", "**/test/**/*.ts"],
      rules: {
        // @effect/vitest layer() owns setup and teardown internally
        "vitest/no-importing-vitest-globals": "off",
        // @effect/vitest layer() owns setup and teardown internally
        "vitest/require-hook": "off",
        // Effect-integrated assert replaces expect.hasAssertions.
        "vitest/prefer-expect-assertions": "off",
        // test harnesses provide their layers at the test's own entry point
        "effecttsgo/strict-effect-provide": "off",
      },
    },
    {
      // OpenCode loads the Kiro plugin's src/ as it is and supplies only
      // effect and @opencode/plugin, so any other package fails to load.
      // src/ is installed on its own, so nothing outside it can be imported
      // either. With no @effect/platform-* package there is no FileSystem,
      // Path or ChildProcess layer, so the plugin uses Node's modules and
      // reads HOME and PATH from process.env.
      files: ["modules/llm/opencode/kiro/src/**"],
      rules: {
        "effecttsgo/node-builtin-import": "off",
        "effecttsgo/process-env": "off",
        "eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["*", ...KIRO_RUNTIME_IMPORTS],
                message:
                  "The Kiro plugin may import only effect, @opencode/plugin, bun:*, node:* and files in src/.",
              },
            ],
          },
        ],
        "node/no-process-env": "off",
      },
    },
    {
      // OpenCode also gives the Kiro sidebar solid-js and OpenTUI, which
      // renders it with Solid's JSX. The React rules misread Solid.
      files: ["modules/llm/opencode/kiro/src/tui.tsx"],
      rules: {
        "eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "*",
                  ...KIRO_RUNTIME_IMPORTS,
                  "!solid-js",
                  "!solid-js/**",
                  "!@opentui/**",
                ],
                message:
                  "The Kiro sidebar may import only effect, @opencode/plugin, solid-js, @opentui/*, bun:*, node:* and files in src/.",
              },
            ],
          },
        ],
        "react/jsx-filename-extension": "off",
        "react/jsx-max-depth": "off",
        "react/no-unknown-property": "off",
        "react/only-export-components": "off",
        "react/purity": "off",
        "react/react-in-jsx-scope": "off",
      },
    },
  ],
  plugins: [
    "unicorn",
    "typescript",
    "oxc",
    "eslint",
    "vitest",
    "node",
    "import",
  ],
  rules: {
    // Maintainers rule aimed at published API stability; these packages are private.
    "effecttsgo/api-stability-leak": "off",
    // Same reasoning: dual data-first/data-last overloads serve library
    // consumers piping our functions; nothing outside these packages calls them.
    "effecttsgo/missing-pipeable-signature": "off",
    // --- not applicable in codebase ---
    "import/default": "off",
    "import/namespace": "off",
    "oxc/no-async-await": "off",
    "oxc/no-optional-chaining": "off",
    "oxc/no-rest-spread-properties": "off",
    "unicorn/throw-new-error": "off", // Effect errors are values (Schema.TaggedError), never thrown

    // --- builtin plugin preferences ---

    "eslint/capitalized-comments": "off",
    "eslint/class-methods-use-this": "off",
    "eslint/func-names": "off",
    "eslint/func-style": "off",
    "eslint/id-length": "off",
    "eslint/max-classes-per-file": "off",
    "eslint/max-lines": "off",
    "eslint/max-lines-per-function": "off",
    "eslint/max-statements": "off",
    "eslint/new-cap": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-duplicate-imports": [
      "error",
      {
        allowSeparateTypeImports: true,
      },
    ],
    "eslint/no-empty-function": "off",
    "eslint/no-inline-comments": "off",
    "eslint/no-magic-numbers": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-ternary": "off",
    "eslint/no-undefined": "off",
    "eslint/no-use-before-define": "off",
    "eslint/no-void": "off",
    "eslint/no-warning-comments": [
      "error",
      { terms: ["@nocommit", "fixme", "xxx"] },
    ],
    // oxfmt will sort imports
    // https://github.com/oxc-project/oxc/issues/14253
    // https://github.com/oxc-project/oxc/issues/13610
    "eslint/sort-imports": "off",
    // perfectionist/sort-objects owns key order
    "eslint/sort-keys": "off",
    // one declaration per statement; comma-joined declarations hurt readability
    "eslint/one-var": ["error", "never"],

    "import/consistent-type-specifier-style": "off",
    "import/exports-last": "off",
    "import/group-exports": "off",
    "import/max-dependencies": "off",
    "import/no-default-export": "off",
    "import/no-named-export": "off",
    "import/no-nodejs-modules": "off",
    "import/no-relative-parent-imports": "off",
    "import/prefer-default-export": "off",

    "typescript/explicit-function-return-type": "off",
    "typescript/explicit-module-boundary-types": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/prefer-readonly-parameter-types": "off",
    "typescript/promise-function-async": "off",
    // effecttsgo/strict-boolean-expressions reports the same thing
    "typescript/strict-boolean-expressions": "off",

    "unicorn/no-array-callback-reference": "off",
    "unicorn/no-array-method-this-argument": "off",
    // both misfire on Effect's data-last Arr.forEach / Arr.reduce in pipe()
    "unicorn/no-array-for-each": "off",
    "unicorn/no-array-reduce": "off",

    // effecttsgo/async-function already bans async functions, so the
    // remaining Promise interop has to chain .then()
    "promise/prefer-await-to-then": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-null": "off",
  },
  settings: {
    vitest: {
      typecheck: false,
    },
  },
});
