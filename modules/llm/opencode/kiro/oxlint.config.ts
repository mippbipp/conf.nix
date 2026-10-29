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
    // untrusted input is decoded with Schema at the boundary, and checked
    // with Predicate, not typeof
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // || is meant on strings: an empty string falls back too
    "typescript/prefer-nullish-coalescing": ["warn", { ignorePrimitives: { string: true } }],
    "eslint/no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
    "eslint/no-warning-comments": ["warn", { terms: ["fixme", "xxx"] }],
    "eslint/one-var": ["error", "never"],

    // --- Effect's idioms, and rules that misread them ---

    // this plugin is private: no published API to keep stable, and each
    // module's functions have one caller, so dual (pipeable) signatures add nothing
    "effecttsgo/api-stability-leak": "off",
    "effecttsgo/missing-pipeable-signature": "off",
    // a Schema and its type share one name
    "eslint/no-redeclare": "off",
    // the three Schema classes are tagged errors, told apart by _tag
    "effecttsgo/schema-class-missing-brand": "off",
    // misreads Schema.TaggedError classes; Effect errors are values, never thrown
    "unicorn/throw-new-error": "off",
    // Effect's constructors (Schema.Struct, Context.Service) are capitalized
    // functions called without new
    "eslint/new-cap": "off",
    // Effect.fn and Effect.gen take anonymous generators; the name is the
    // binding's, or Effect.fn's span name
    "eslint/func-names": "off",
    // Effect.fn's results are consts and the plain helpers are declarations,
    // so one style can't hold
    "eslint/func-style": "off",
    // misreads Effect's data-first calls (Arr.map(xs, f)) as a thisArg
    "unicorn/no-array-method-this-argument": "off",
    // wants for-of, while prefer-effect-array turns each forEach into Arr.forEach
    "unicorn/no-array-for-each": "off",
    // Schema definitions and Effect pipelines nest calls
    "unicorn/max-nested-calls": "off",
    // Effect.as takes the value to succeed with, here undefined
    "unicorn/no-useless-undefined": "off",
    // Effect.sync and Effect.callback take one-line arrows that return void
    "typescript/no-confusing-void-expression": "off",
    // the arrows handed to Effect.tryPromise return a Promise; async would add nothing
    "typescript/promise-function-async": "off",
    // each type assertion states why it is safe instead
    // (anti-slop/require-safety-comment-for-type-assertion)
    "typescript/no-unsafe-type-assertion": "off",

    // --- what tsc already checks ---

    // tsc resolves every import and global, including Bun's and the web's,
    // which oxlint's no-undef doesn't know
    "import/named": "off",
    "import/default": "off",
    "import/namespace": "off",
    "eslint/no-undef": "off",
    // tsc checks that a let is assigned on every path before it is read
    "eslint/init-declarations": "off",
    // inferred return types are the contract: a Schema's or an Effect's type
    // written out by hand would only drift from it
    "typescript/explicit-module-boundary-types": "off",
    "typescript/explicit-function-return-type": "off",

    // --- the runtime ---

    // these keep code to ES5; Bun runs ESNext. effecttsgo/async-function
    // already keeps async functions out of src/
    "oxc/no-async-await": "off",
    "oxc/no-optional-chaining": "off",
    "oxc/no-rest-spread-properties": "off",
    // OpenCode provides no FileSystem, Path or ChildProcess layer and the
    // plugin can't import @effect/platform-*, so it uses Node's modules and
    // reads HOME and PATH from process.env
    "effecttsgo/node-builtin-import": "off",
    "effecttsgo/process-env": "off",
    "node/no-process-env": "off",
    "import/no-nodejs-modules": "off",
    // checking that a local file exists is quick enough to do in step
    "node/no-sync": "off",

    // --- the protocols ---

    // keys follow the order of Kiro's and OpenCode's formats
    "eslint/sort-keys": "off",
    // HTTP statuses and Kiro's sizes read clearer as literals than as names used once
    "eslint/no-magic-numbers": "off",
    // the event stream reader sizes and limits frames with shifts
    "eslint/no-bitwise": "off",
    // Kiro's JSON and the RPC use null
    "unicorn/no-null": "off",
    // undefined is the absent value of optional fields and Map lookups
    "eslint/no-undefined": "off",
    // adding u can change what a regex matches
    "eslint/require-unicode-regexp": "off",
    // a translator follows Kiro's request and reply formats case by case, so
    // its functions and files run as long as those formats
    "eslint/max-lines-per-function": "off",
    "eslint/max-lines": "off",
    "eslint/max-statements": "off",
    // the translation code depends on the truthiness of "", 0 and undefined
    // in hundreds of places; rewriting it risks changing what Kiro is sent
    "effecttsgo/strict-boolean-expressions": "off",
    "typescript/strict-boolean-expressions": "off",
    "unicorn/explicit-length-check": "off",
    // !! turns an optional field into the boolean Effect's Array predicates take
    "eslint/no-implicit-coercion": "off",
    // optional fields are added with a conditional spread, so the key is left
    // out rather than present as undefined
    "anti-slop/no-conditional-empty-object-spread": "off",
    // a translator that skips what it can't send reads best with continue
    "eslint/no-continue": "off",
    // String(x ?? "") also covers a JSON value the declared type doesn't
    "typescript/no-unnecessary-type-conversion": "off",
    // a switch over a closed union of event kinds has no default case
    "eslint/default-case": "off",
    // the translators are split into one step per rule of Kiro's formats,
    // so a function past these limits is doing more than one step
    "eslint/complexity": ["warn", { max: 20 }],
    "eslint/max-depth": ["warn", { max: 4 }],
    // kiroRequest, events and reply each take four values that travel
    // together nowhere else, so an options object would only rename them
    "eslint/max-params": ["warn", { max: 4 }],

    // --- layout ---

    // oxfmt sorts imports
    "eslint/sort-imports": "off",
    // the code leaves out braces around a one-statement body, which oxfmt
    // may wrap onto the next line
    "eslint/curly": "off",
    // this code marks a change of step with a comment, not a blank line
    "anti-slop/require-readable-spacing": "off",
    // comments carry on from the code in lower case
    "eslint/capitalized-comments": "off",
    // a field's unit or meaning goes on its line
    "eslint/no-inline-comments": "off",
    // helpers sit below the code that uses them, which runs them later
    "eslint/no-use-before-define": "off",
    // oxfmt writes hex digits in lower case, this rule wants upper, and
    // neither can be configured
    "unicorn/number-literal-case": "off",
    // a value picked from two or three cases is a ternary chain, which oxfmt
    // lays out one case to a line
    "eslint/no-ternary": "off",
    "eslint/no-nested-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    // the encoder's cases declare nothing, so braces would only add lines
    "unicorn/switch-case-braces": "off",
    // loop counters step with ++ and --
    "eslint/no-plusplus": "off",
    // the sidebar lets Solid's refetch run with void
    "eslint/no-void": "off",
    // destructuring a single field reads worse than the access
    "eslint/prefer-destructuring": "off",
    // join and delimiter are clearer than path.join
    "unicorn/import-style": "off",
    // a module is imported as a namespace (Failure, Conversation) when its
    // names only make sense with it
    "import/no-namespace": "off",
    // modules export by name; OpenCode loads index.ts and tui.tsx by their
    // default export
    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "import/no-default-export": "off",
    // each export sits with its definition
    "import/exports-last": "off",
    "import/group-exports": "off",
    // index.ts and account.ts join the other modules, so their imports grow with them
    "import/max-dependencies": "off",
    // type imports sit inline beside values, as no-duplicate-imports wants one import a module
    "import/consistent-type-specifier-style": "off",
    // the tests import src/ from beside it
    "import/no-relative-parent-imports": "off",
    // the tests send their requests one after another on purpose
    "eslint/no-await-in-loop": "off",
    // a module keeps its error classes, or its reader and writer classes, together
    "eslint/max-classes-per-file": "off",
    // a class member is public unless marked, as TypeScript has it
    "typescript/explicit-member-accessibility": "off",
    // the two classes take their fixed settings as readonly parameter properties
    "typescript/parameter-properties": "off",
    // interfaces name the protocol shapes, type aliases the small ones and
    // unions; tsc checks both alike
    "typescript/consistent-type-definitions": "off",
    // Effect's and OpenCode's types aren't deeply readonly, so few parameters could be
    "typescript/prefer-readonly-parameter-types": "off",
    // a name says what it holds; the only one-letter names are _ for a value
    // not used and i for a loop or array index. Type parameters are A and E,
    // as in Effect's own signatures, and property names are Kiro's and
    // OpenCode's
    "eslint/id-length": [
      "warn",
      { min: 2, exceptions: ["_", "i"], checkGeneric: false, properties: "never" },
    ],
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
        // Solid view code keys memos and resources on plain joined strings;
        // sidebar.ts holds the logic, in Effect's modules
        "effecttsgo/prefer-effect-array": "off",
        "effecttsgo/prefer-effect-record": "off",
        "effecttsgo/prefer-effect-string": "off",
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
        // a test reads [0]! or a handler! it has just checked is there, and
        // a missing one fails the test anyway
        "typescript/no-non-null-assertion": "off",
        // the fakes stand in for OpenCode's storage, hooks, RPC and Standard
        // Schema check, which take unknown
        "anti-slop/no-unknown-parameters": "off",
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
