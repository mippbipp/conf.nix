import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { AgentError } from "../src/agent.ts";
import { parseFixerCommit } from "../src/branch-state.ts";
import { FlakeLock, formatLock, parseLock, shortRev } from "../src/lock.ts";
import {
  readFailures,
  repairRound,
  roundOutcome,
} from "../src/repair-round.ts";
import type { RoundOutcome } from "../src/repair-round.ts";
import {
  edits,
  failed,
  fixerLayer,
  lockAt,
  fixerWorkspace,
  World,
} from "./fakes.ts";
import { gate232 } from "./fixtures/gate-232.ts";

/** The update branch one commit past main, with flake.lock at `head`. */
const onBranch = (main: string, head: string) => {
  const world = new World();
  world.main = new Map([["flake.lock", main]]);
  world.head = new Map([["flake.lock", head]]);
  world.commits = [{ sha: world.next("c"), message: "up" }];

  return world;
};

const updated = () =>
  onBranch(lockAt({ nixpkgs: "aaaaaaa" }), lockAt({ nixpkgs: "bbbbbbb" }));

const roundIn = Effect.fn("roundIn")(function* (world: World) {
  const main = yield* parseLock(world.main.get("flake.lock") ?? "");

  return yield* repairRound({
    pr: 42,
    round: 1,
    main,
    failures: readFailures(failed("build x86_64-linux", gate232).failed)
      .failures,
    session: Option.none(),
    feedback: Option.none(),
  }).pipe(Effect.provide(fixerLayer(world)));
});

const expectOutcome =
  <Tag extends RoundOutcome["_tag"]>(tag: Tag) =>
  (outcome: RoundOutcome) =>
    roundOutcome.$is(tag)(outcome)
      ? Effect.succeed(outcome)
      : Effect.die(`expected ${tag}, got ${JSON.stringify(outcome)}`);

const lastCommit = (world: World) =>
  parseFixerCommit(world.commits.at(-1)?.message ?? "");

const github = (repo: string, rev: string) => ({
  lastModified: 1_793_000_000,
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

/** nixos-hardware pointing at the root nixpkgs node by key, not by follows. */
const sharedNixpkgs = (nixpkgs: string, hardware: string) =>
  formatLock(
    FlakeLock.make({
      nodes: {
        "nixos-hardware": {
          inputs: { nixpkgs: "nixpkgs" },
          locked: github("nixos-hardware", hardware),
          original: original("nixos-hardware"),
        },
        nixpkgs: {
          locked: github("nixpkgs", nixpkgs),
          original: original("nixpkgs"),
        },
        root: {
          inputs: { "nixos-hardware": "nixos-hardware", nixpkgs: "nixpkgs" },
        },
      },
      root: "root",
      version: 7,
    })
  );

describe("repair round", () => {
  it.effect("commits a configuration fix and marks it for review", () =>
    Effect.gen(function* () {
      const world = updated();
      world.agent.push(
        edits(
          { "modules/system/config/common.nix": "{ }\n" },
          { summary: "drop removed boot.initrd options" }
        )
      );

      const outcome = yield* roundIn(world).pipe(
        Effect.flatMap(expectOutcome("Committed"))
      );

      assert.strictEqual(outcome.sha, "c2");
      assert.isTrue(outcome.reviewRequired);
      assert.deepStrictEqual(outcome.reverted, []);
      assert.strictEqual(outcome.session, "ses_test");
      assert.strictEqual(
        world.head.get("modules/system/config/common.nix"),
        "{ }\n"
      );
      assert.deepStrictEqual(world.pushes, [{ replace: false, sha: "c2" }]);
      assert.deepStrictEqual(
        lastCommit(world),
        Option.some({
          subject: "drop removed boot.initrd options",
          trailers: {
            round: "1",
            session: "ses_test",
            reviewRequired: true,
            reverted: [],
          },
        })
      );

      const [request] = world.repairRequests;
      assert.deepStrictEqual(world.workspaceDirs, [
        fixerWorkspace,
        fixerWorkspace,
      ]);
      assert.strictEqual(request?.title, "flake-update #42");
      assert.include(request?.failures, "boot.initrd.systemd.enable");
      assert.include(request?.changes, "nixpkgs aaaaaaa→bbbbbbb");
    })
  );

  it.effect("discards a round that touches a blocked path", () =>
    Effect.gen(function* () {
      for (const path of [".github/x", "hosts/gram/.opencode/x"]) {
        const world = updated();
        world.agent.push(edits({ [path]: "x\n" }));

        const outcome = yield* roundIn(world).pipe(
          Effect.flatMap(expectOutcome("Discarded"))
        );

        assert.include(outcome.reason, path);
        assert.strictEqual(outcome.session, "ses_test");
        assert.lengthOf(world.commits, 1);
        assert.deepStrictEqual(world.pushes, []);
      }
    })
  );

  it.effect("discards a round whose report does not match its changes", () =>
    Effect.gen(function* () {
      const world = updated();
      world.agent.push(
        edits(
          { "modules/a.nix": "a\n", "modules/b.nix": "b\n" },
          { filesChanged: ["modules/a.nix"] }
        )
      );

      const outcome = yield* roundIn(world).pipe(
        Effect.flatMap(expectOutcome("Discarded"))
      );

      assert.include(outcome.reason, "modules/b.nix");
      assert.lengthOf(world.commits, 1);
      assert.deepStrictEqual(world.pushes, []);
    })
  );

  it.effect("rebuilds flake.lock from main's entry for a reverted input", () =>
    Effect.gen(function* () {
      const world = onBranch(
        lockAt({ "home-manager": "1111111", nixpkgs: "aaaaaaa" }),
        lockAt({ "home-manager": "2222222", nixpkgs: "bbbbbbb" })
      );

      world.agent.push(
        edits(
          { "flake.lock": "garbage" },
          {
            outcome: "reverted",
            revertedInputs: ["nixpkgs"],
            filesChanged: [],
            summary: "nixpkgs bbbbbbb breaks every host",
          }
        )
      );

      const outcome = yield* roundIn(world).pipe(
        Effect.flatMap(expectOutcome("Committed"))
      );

      const lock = yield* parseLock(world.head.get("flake.lock") ?? "");
      assert.strictEqual(shortRev(lock, "nixpkgs"), "aaaaaaa");
      assert.strictEqual(shortRev(lock, "home-manager"), "2222222");
      assert.isFalse(outcome.reviewRequired);
      assert.deepStrictEqual(outcome.reverted, ["nixpkgs"]);
      assert.deepStrictEqual(
        Option.map(lastCommit(world), (commit) => commit.trailers),
        Option.some({
          round: "1",
          session: "ses_test",
          reviewRequired: false,
          reverted: ["nixpkgs"],
        })
      );
    })
  );

  it.effect("asks for review when a revert moves an input that shares it", () =>
    Effect.gen(function* () {
      // Reverting nixpkgs also changes nixos-hardware, which shares the node
      // but is not back at main's revision.
      const world = onBranch(
        sharedNixpkgs("aaaaaaa", "1111111"),
        sharedNixpkgs("bbbbbbb", "2222222")
      );

      world.agent.push(
        edits(
          {},
          {
            outcome: "reverted",
            revertedInputs: ["nixpkgs"],
            summary: "hold nixpkgs back",
          }
        )
      );

      const outcome = yield* roundIn(world).pipe(
        Effect.flatMap(expectOutcome("Committed"))
      );

      assert.isTrue(outcome.reviewRequired);
      assert.deepStrictEqual(outcome.reverted, ["nixpkgs"]);
      assert.deepStrictEqual(
        Option.map(
          lastCommit(world),
          (commit) => commit.trailers.reviewRequired
        ),
        Option.some(true)
      );
    })
  );

  it.effect("reports an unavailable Flake fixer and commits nothing", () =>
    Effect.gen(function* () {
      const world = updated();
      world.agent.push(() =>
        Effect.fail(
          AgentError.make({
            reason: "unavailable",
            message: "free usage limit reached",
            session: "ses_limit",
          })
        )
      );

      const outcome = yield* roundIn(world).pipe(
        Effect.flatMap(expectOutcome("AgentFailed"))
      );

      assert.strictEqual(outcome.error.reason, "unavailable");
      assert.strictEqual(outcome.error.session, "ses_limit");
      assert.lengthOf(world.commits, 1);
      assert.deepStrictEqual(world.pushes, []);
      assert.strictEqual(world.trees.size, 0);
    })
  );
});
