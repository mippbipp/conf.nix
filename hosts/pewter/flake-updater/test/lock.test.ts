import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { FlakeLock, revertInputs, sameRevision } from "../src/lock.ts";

const locked = (repo: string, rev: string) => ({
  narHash: `sha256-${rev}${repo}`,
  owner: "upstream",
  repo,
  rev,
  type: "github",
});

const original = (repo: string) => ({
  owner: "upstream",
  repo,
  type: "github",
});

describe("lock", () => {
  it.effect("reverts inputs whose node keys the update renumbered", () =>
    Effect.sync(() => {
      const main = FlakeLock.make({
        nodes: {
          root: { inputs: { herdr: "herdr", nixpkgs: "nixpkgs" } },
          nixpkgs: {
            locked: locked("nixpkgs", "aaaaaaa"),
            original: original("nixpkgs"),
          },
          herdr: {
            inputs: { nixpkgs: "nixpkgs_2" },
            locked: locked("herdr", "1111111"),
            original: original("herdr"),
          },
          nixpkgs_2: {
            locked: locked("nixpkgs", "ccccccc"),
            original: original("nixpkgs"),
          },
        },
        root: "root",
        version: 7,
      });

      // The update swapped which key holds the root nixpkgs.
      const branch = FlakeLock.make({
        nodes: {
          root: { inputs: { herdr: "herdr", nixpkgs: "nixpkgs_2" } },
          nixpkgs_2: {
            locked: locked("nixpkgs", "bbbbbbb"),
            original: original("nixpkgs"),
          },
          herdr: {
            inputs: { nixpkgs: "nixpkgs" },
            locked: locked("herdr", "2222222"),
            original: original("herdr"),
          },
          nixpkgs: {
            locked: locked("nixpkgs", "ddddddd"),
            original: original("nixpkgs"),
          },
        },
        root: "root",
        version: 7,
      });

      const reverted = revertInputs(branch, main, ["herdr", "nixpkgs"]);

      assert.isTrue(sameRevision(reverted, main, "herdr"));
      assert.isTrue(sameRevision(reverted, main, "nixpkgs"));
    })
  );
});
