import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "*.md",
    "*.nix",
    // vendored oxlint plugin: don't reformat third-party-owned source
    "tools/oxlint/anti-slop/**",
    // captured CI and API output kept verbatim as test data
    "**/test/fixtures/**",
    "**/dist/**",
    // separate Bun project outside the workspace, with its own format setup
    "modules/llm/opencode/kiro/**",
    // skills submodule
    "modules/llm/skills/**",
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
