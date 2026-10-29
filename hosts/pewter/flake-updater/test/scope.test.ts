import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order } from "effect";

import { blockedGlobs, isBlocked } from "../src/scope.ts";

describe("scope", () => {
  it.effect("blocks every listed path", () =>
    Effect.sync(() => {
      const blocked = [
        ".github/workflows/build-gate.yml",
        "secrets/me.yaml",
        "hosts/pewter/flake-updater/src/scope.ts",
        "hosts/pewter/flake-updater/blocked-paths.json",
        ".sops.yaml",
        "checks.nix",
        ".git/config",
        "modules/vendored/.git/hooks/post-checkout",
        ".opencode/agent/x.md",
        "hosts/gram/.opencode/plugin.ts",
        "opencode.json",
        "modules/llm/opencode.jsonc",
      ];

      assert.deepStrictEqual(Arr.filter(blocked, isBlocked), blocked);
    })
  );

  it.effect("allows ordinary configuration", () =>
    Effect.sync(() => {
      const allowed = [
        "hosts/gram/default.nix",
        "flake.lock",
        "flake.nix",
        "secretsfoo/x",
        "hosts/secrets/x.nix",
        "modules/checks.nix",
        "hosts/pewter/default.nix",
        ".githubx/y",
        "modules/git/default.nix",
      ];

      assert.deepStrictEqual(Arr.filter(allowed, isBlocked), []);
    })
  );

  it.effect("renders the list as opencode globs", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Arr.sort(blockedGlobs, Order.String), [
        "*.git/*",
        "*.opencode/*",
        "*opencode.json*",
        ".github/*",
        ".sops.yaml",
        "checks.nix",
        "hosts/pewter/flake-updater/*",
        "secrets/*",
      ]);
    })
  );
});
