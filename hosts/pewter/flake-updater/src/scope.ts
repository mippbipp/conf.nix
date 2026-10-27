import { Array as Arr, String as Str } from "effect";

/**
 * Paths the Flake fixer may never change. The `flake-update-scope` workflow
 * and the edit denies in opencode-config.nix enforce the same list; keep the
 * three in sync.
 */
export const blockedPrefixes = [
  ".github/",
  "secrets/",
  "hosts/pewter/flake-updater/",
];

export const blockedFiles = [".sops.yaml", "checks.nix"];

export const isBlocked = (path: string): boolean =>
  Arr.contains(blockedFiles, path) ||
  Arr.some(blockedPrefixes, (prefix) => Str.startsWith(prefix)(path));
