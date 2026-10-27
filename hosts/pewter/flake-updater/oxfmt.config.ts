import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "*.md",
    "*.nix",
    // vendored oxlint plugin: don't reformat third-party-owned source
    "tools/oxlint/anti-slop/**",
    // captured CI output kept verbatim as test data
    "test/fixtures/**",
  ],
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "es5",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  sortImports: {},
});
