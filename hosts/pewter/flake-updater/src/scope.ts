import { Array as Arr, String as Str } from "effect";

import blockedPaths from "../blocked-paths.json" with { type: "json" };

/**
 * Paths the Flake fixer may never change, from blocked-paths.json. The
 * `flake-update-scope` workflow and the policies in opencode-config.nix read
 * the same file.
 */
const { prefixes, files, substrings } = blockedPaths;

export const isBlocked = (path: string): boolean =>
  Arr.contains(files, path) ||
  Arr.some(prefixes, (prefix) => Str.startsWith(prefix)(path)) ||
  Arr.some(substrings, (substring) => Str.includes(substring)(path));

/** Every entry, for telling the agent what it may not change. */
export const blockedEntries: readonly string[] = [
  ...prefixes,
  ...files,
  ...substrings,
];

/** The same list as opencode permission globs. */
export const blockedGlobs: readonly string[] = [
  ...Arr.map(prefixes, (prefix) => `${prefix}*`),
  ...files,
  ...Arr.map(substrings, (substring) => `*${substring}*`),
];
