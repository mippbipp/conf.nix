import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Option } from "effect";

import {
  deriveBranchState,
  formatFixerCommit,
  heldBackMarker,
  heldBackTitle,
  parseFixerCommit,
} from "../src/branch-state.ts";
import type { BranchCommit } from "../src/git.ts";
import type { Issue } from "../src/github.ts";
import { FlakeLock } from "../src/lock.ts";

const github = (repo: string, rev: string) => ({
  lastModified: 1_793_000_000,
  narHash: `sha256-${rev}${repo}`,
  owner: "upstream",
  repo,
  rev,
  type: "github",
});

/**
 * nixos-hardware at a fixed revision whose own nixpkgs input is a real child
 * node at `nestedRev`, beside a root nixpkgs at `rev`.
 */
const nestedLock = (rev: string, nestedRev: string) =>
  FlakeLock.make({
    nodes: {
      "nixos-hardware": {
        inputs: { nixpkgs: "nixpkgs_2" },
        locked: github("nixos-hardware", "1111111"),
        original: { owner: "upstream", repo: "nixos-hardware", type: "github" },
      },
      nixpkgs: {
        locked: github("nixpkgs", rev),
        original: { owner: "upstream", repo: "nixpkgs", type: "github" },
      },
      nixpkgs_2: {
        locked: github("nixpkgs", nestedRev),
        original: { owner: "upstream", repo: "nixpkgs", type: "github" },
      },
      root: {
        inputs: { "nixos-hardware": "nixos-hardware", nixpkgs: "nixpkgs" },
      },
    },
    root: "root",
    version: 7,
  });

/** A root input whose locked attributes carry no narHash. */
const bareLock = (rev: string) =>
  FlakeLock.make({
    nodes: {
      tool: {
        locked: { owner: "upstream", repo: "tool", rev, type: "github" },
        original: { owner: "upstream", repo: "tool", type: "github" },
      },
      root: { inputs: { tool: "tool" } },
    },
    root: "root",
    version: 7,
  });

const heldBackIssue = (main: FlakeLock, input: string): Issue => ({
  number: 5,
  title: heldBackTitle(input),
  body: `${heldBackMarker(main, input)}\nThe Flake fixer reverted it.`,
  url: "https://github.test/issues/5",
});

const fixerCommit = (
  sha: string,
  summary: string,
  trailers: { reviewRequired: boolean; reverted: readonly string[] }
): BranchCommit => ({
  sha,
  message: formatFixerCommit(summary, {
    round: "1",
    session: "ses_old",
    ...trailers,
  }),
});

const landedTitles = (state: ReturnType<typeof deriveBranchState>) =>
  Arr.map(state.landed, (landed) => landed.issue.title);

describe("branch state", () => {
  it.effect("parses the trailers it formats", () =>
    Effect.sync(() => {
      const trailers = {
        round: "2",
        session: "ses_abc",
        reviewRequired: true,
        reverted: ["home-manager", "nixpkgs"],
      };

      const message = formatFixerCommit(
        "revert nixpkgs and home-manager\n\nBoth break stage 1.",
        trailers
      );

      assert.deepStrictEqual(
        parseFixerCommit(message),
        Option.some({ subject: "revert nixpkgs and home-manager", trailers })
      );
    })
  );

  it.effect("tracks an input whose only change is in its own inputs", () =>
    Effect.sync(() => {
      const main = nestedLock("aaaaaaa", "aaaaaaa");

      const commits = [
        fixerCommit("c2", "nixos-hardware breaks gram", {
          reviewRequired: false,
          reverted: ["nixos-hardware"],
        }),
      ];

      const issues = [heldBackIssue(main, "nixos-hardware")];

      const held = deriveBranchState({ commits, head: main, main, issues });

      assert.deepStrictEqual(
        Arr.map(held.heldBack, (input) => input.input),
        ["nixos-hardware"]
      );
      assert.deepStrictEqual(landedTitles(held), []);

      const moved = nestedLock("aaaaaaa", "bbbbbbb");

      const landed = deriveBranchState({
        commits,
        head: main,
        main: moved,
        issues,
      });

      assert.deepStrictEqual(landed.heldBack, []);
      assert.deepStrictEqual(landedTitles(landed), [
        "flake-update: nixos-hardware held back",
      ]);
    })
  );

  it.effect("keeps the held-back marker stable across runs", () =>
    Effect.sync(() => {
      // Issue bodies outlive this code: a changed digest closes every open
      // held-back issue on the next run.
      assert.strictEqual(
        heldBackMarker(bareLock("aaaaaaa"), "tool"),
        "<!-- flake-update main-entry=b32bec51 -->"
      );
    })
  );

  it.effect("closes the held-back issue of an input without a narHash", () =>
    Effect.sync(() => {
      const issues = [heldBackIssue(bareLock("aaaaaaa"), "tool")];

      const landedOn = (main: FlakeLock) =>
        landedTitles(
          deriveBranchState({
            commits: [],
            head: bareLock("aaaaaaa"),
            main,
            issues,
          })
        );

      assert.deepStrictEqual(landedOn(bareLock("aaaaaaa")), []);
      assert.deepStrictEqual(landedOn(bareLock("bbbbbbb")), [
        "flake-update: tool held back",
      ]);
    })
  );

  it.effect("gives the latest reason for an input held back twice", () =>
    Effect.sync(() => {
      const main = nestedLock("aaaaaaa", "aaaaaaa");

      const state = deriveBranchState({
        commits: [
          fixerCommit("c1", "nixpkgs breaks gram", {
            reviewRequired: false,
            reverted: ["nixpkgs"],
          }),
          fixerCommit("c2", "nixpkgs breaks every host", {
            reviewRequired: false,
            reverted: ["nixpkgs"],
          }),
        ],
        head: main,
        main,
        issues: [],
      });

      assert.deepStrictEqual(
        Arr.map(state.heldBack, (input) => input.reason),
        ["nixpkgs breaks every host"]
      );
    })
  );

  it.effect(
    "reads review and held-back inputs from an earlier run's commits",
    () =>
      Effect.sync(() => {
        const main = nestedLock("aaaaaaa", "aaaaaaa");
        const head = nestedLock("aaaaaaa", "bbbbbbb");
        const issue = heldBackIssue(main, "nixpkgs");

        const state = deriveBranchState({
          commits: [
            { sha: "c1", message: "up" },
            fixerCommit("c2", "drop removed boot.initrd options", {
              reviewRequired: true,
              reverted: [],
            }),
            fixerCommit("c3", "nixpkgs breaks every host", {
              reviewRequired: false,
              reverted: ["nixpkgs"],
            }),
          ],
          head,
          main,
          issues: [issue],
        });

        assert.isTrue(state.needsReview);
        assert.deepStrictEqual(state.heldBack, [
          {
            input: "nixpkgs",
            reason: "nixpkgs breaks every host",
            issue: Option.some(issue.url),
          },
        ]);
        assert.deepStrictEqual(
          Arr.map(state.fixerCommits, (commit) => [
            commit.subject,
            commit.trailers.reviewRequired,
          ]),
          [
            ["drop removed boot.initrd options", true],
            ["nixpkgs breaks every host", false],
          ]
        );
      })
  );
});
