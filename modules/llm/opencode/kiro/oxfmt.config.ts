import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "*.md",
    // vendored oxlint plugin: don't reformat third-party-owned source
    "tools/oxlint/anti-slop/**",
  ],
  // the code was written to 100 columns
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  jsxSingleQuote: false,
  trailingComma: "es5",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  sortImports: {},
});
