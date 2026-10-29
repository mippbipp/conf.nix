import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

// what OpenCode lets the plugin import at runtime, as gitignore-style
// exceptions to a "*" pattern
const RUNTIME_IMPORTS = [
  "!effect",
  "!effect/**",
  "!@opencode/plugin",
  "!@opencode/plugin/**",
  "!bun:*",
  "!node:*",
  "!node:*/*",
  "!./*",
];

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
  plugins: ["unicorn", "typescript", "oxc", "eslint", "node", "import"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    // --- what the plugin may import at runtime ---

    // OpenCode loads src/ as it is and supplies only effect and
    // @opencode/plugin, so any other package fails to load. src/ is
    // installed on its own, so nothing outside it can be imported either.
    "eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["*", ...RUNTIME_IMPORTS],
            message:
              "The server part may import only effect, @opencode/plugin, bun:*, node:* and files in src/.",
          },
        ],
      },
    ],

    // --- anti-slop js plugin preferences ---

    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Maintainers rule aimed at published API stability; this plugin is private.
    "effecttsgo/api-stability-leak": "off",
    // dual (pipeable) signatures are for published libraries; this plugin's modules have one caller
    "effecttsgo/missing-pipeable-signature": "off",

    // --- not applicable in codebase ---

    "import/named": "off",
    "import/default": "off",
    "import/namespace": "off",
    "eslint/no-undef": "off",
    "oxc/no-async-await": "off",
    "oxc/no-optional-chaining": "off",
    "oxc/no-rest-spread-properties": "off",

    // --- builtin plugin preferences ---

    // oxfmt sorts imports
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
    "eslint/no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
    "eslint/no-plusplus": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-promise-executor-return": "off",
    "eslint/no-inline-comments": "off",
    "eslint/no-warning-comments": ["warn", { terms: ["fixme", "xxx"] }],
    "eslint/no-use-before-define": "off",
    "eslint/no-empty-function": "off",
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

    "typescript/no-unsafe-type-assertion": "off",
    "typescript/explicit-module-boundary-types": "off",
    "typescript/explicit-function-return-type": "off",
    "typescript/promise-function-async": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/prefer-readonly-parameter-types": "off",

    "unicorn/prefer-ternary": "off",
    "unicorn/prefer-add-event-listener": "off",
    "unicorn/no-array-method-this-argument": "off",
    "unicorn/no-array-callback-reference": "off",
    "unicorn/no-null": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/switch-case-braces": "off",
    "unicorn/no-array-reduce": "off",

    // --- this plugin's runtime and style ---

    // the code leaves out braces around a one-statement body, which oxfmt
    // may wrap onto the next line
    "eslint/curly": "off",
    // this code marks a change of step with a comment, not a blank line
    "anti-slop/require-readable-spacing": "off",
    // this code tests values with JavaScript's own truthiness throughout
    "effecttsgo/strict-boolean-expressions": "off",
    // OpenCode hands the plugin no FileSystem, Path or ChildProcess service,
    // so it works through Node's modules, and reads HOME and PATH on each call
    "effecttsgo/node-builtin-import": "off",
    "effecttsgo/process-env": "off",
    "node/no-process-env": "off",
    // native array, record and string methods read more plainly here
    "effecttsgo/prefer-effect-array": "off",
    "effecttsgo/prefer-effect-record": "off",
    "effecttsgo/prefer-effect-string": "off",
    // Kiro's numbers arrive as JSON, which has no NaN or Infinity
    "effecttsgo/schema-number": "off",
    // the request and reply translation reads loosely typed JSON from
    // OpenCode and Kiro, and checks it with typeof as it goes
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-object-parameters": "off",
    // optional fields are added with a conditional spread throughout
    "anti-slop/no-conditional-empty-object-spread": "off",
    // lookup tables and header maps are declared as Records on purpose
    "anti-slop/no-known-value-widening": "off",
    // the casts brand OpenCode IDs and type the hook's JSON body
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    // each ! is on a field this code just set or checked
    "typescript/no-non-null-assertion": "off",
    // || is meant: an empty string falls back too
    "typescript/prefer-nullish-coalescing": "off",
    "unicorn/explicit-length-check": "off",
    "eslint/no-implicit-coercion": "off",
    // a translator that skips what it can't send reads best with continue
    "eslint/no-continue": "off",
    // string building and regexes are ASCII protocol text
    "eslint/prefer-template": "off",
    "eslint/require-unicode-regexp": "off",
    "unicorn/prefer-string-replace-all": "off",
    // Schema calls nest by design
    "unicorn/max-nested-calls": "off",
    // a Schema and its type share one name
    "eslint/no-redeclare": "off",
    // the translation functions mirror Kiro's request and reply formats,
    // which have that many cases, until index.ts is split up
    "eslint/complexity": "off",
    "eslint/max-depth": "off",
    "eslint/max-params": "off",
    // class members are public unless marked; type aliases are used for
    // object types as much as interfaces
    "typescript/explicit-member-accessibility": "off",
    "typescript/parameter-properties": "off",
    "typescript/consistent-type-definitions": "off",
    // the existing literals (250000, 0xff) stay as written
    "unicorn/numeric-separators-style": "off",
    "unicorn/number-literal-case": "off",
    // checking that a local file exists is quick enough to do in step
    "node/no-sync": "off",
    // misreads Schema.TaggedError classes; Effect errors are values, never thrown
    "unicorn/throw-new-error": "off",
    // destructuring a single field reads worse than the access
    "eslint/prefer-destructuring": "off",
    // Schema classes here aren't passed where another class could stand in
    "effecttsgo/schema-class-missing-brand": "off",
    // the Schema JSON round trip would add nothing to a value compare or a
    // body the code just built
    "effecttsgo/prefer-schema-over-json": "off",
    // a caught JavaScript error is e, as everywhere else in this code
    "unicorn/catch-error-name": "off",
    // join and delimiter are clearer than path.join
    "unicorn/import-style": "off",
    // a switch over a closed union of event kinds has no default case
    "eslint/default-case": "off",
    // some signatures need an explicit undefined argument
    "unicorn/no-useless-undefined": "off",
    // String(x ?? "") also covers a JSON value the declared type doesn't
    "typescript/no-unnecessary-type-conversion": "off",
    // the tests reach the plugin's functions through this one export
    "eslint/no-underscore-dangle": ["error", { allow: ["_internal", "_tag"] }],
  },
  overrides: [
    {
      // the sidebar also gets solid-js and OpenTUI from OpenCode
      files: ["src/tui.tsx"],
      rules: {
        // Solid's JSX children and OpenTUI's elements type as any
        "typescript/no-unsafe-return": "off",
        // OpenCode's TUI client is Promise-based, and Solid's createResource
        // takes a Promise
        "effecttsgo/async-function": "off",
        // the sidebar shows days to the reset by the wall clock
        "effecttsgo/global-date": "off",
        "eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["*", ...RUNTIME_IMPORTS, "!solid-js", "!solid-js/**", "!@opentui/**"],
                message:
                  "The sidebar may import only effect, @opencode/plugin, solid-js, @opentui/*, bun:*, node:* and files in src/.",
              },
            ],
          },
        ],
      },
    },
    {
      // tests and config run from this directory with its node_modules
      files: ["test/**", "*.config.ts"],
      rules: {
        "eslint/no-restricted-imports": "off",
      },
    },
    {
      files: ["test/**"],
      rules: {
        // bun:test takes async tests, and the fake network is async functions
        // whether or not they await
        "effecttsgo/async-function": "off",
        "eslint/require-await": "off",
        "typescript/require-await": "off",
        "unicorn/no-await-expression-member": "off",
        // the hooks are fed real fetch Requests and Responses
        "effecttsgo/global-fetch": "off",
        // the fake host stands in for OpenCode's context, and the SSE events
        // and stored tokens are read as plain JSON
        "anti-slop/no-chained-type-assertions": "off",
        "typescript/no-explicit-any": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "unicorn/no-object-as-default-parameter": "off",
        "effecttsgo/any-unknown-in-error-context": "off",
        // tests match errors and request bodies by their _tag
        "anti-slop-effect/no-manual-tag-comparison": "off",
        "anti-slop-effect/no-manual-tagged-construction": "off",
        // helpers sit beside the test that uses them
        "unicorn/consistent-function-scoping": "off",
        // sign-ins are written with expiry times from Date.now()
        "effecttsgo/global-date": "off",
        // each test provides the plugin's layer, as OpenCode does
        "effecttsgo/strict-effect-provide": "off",
      },
    },
  ],
  env: {
    builtin: true,
  },
  ignorePatterns: [
    // agent tooling dirs and the vendored plugin itself are not plugin source
    ".agents/**",
    ".opencode/**",
    "tools/oxlint/anti-slop/**",
  ],
});
