import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { AgentError } from "../src/agent.ts";
import { parseLock, shortRev } from "../src/lock.ts";
import { run } from "../src/updater.ts";
import { edits, failed, lockAt, World, worldLayer } from "./fakes.ts";
import { gate232 } from "./fixtures/gate-232.ts";

const runIn = (world: World) => run().pipe(Effect.provide(worldLayer(world)));

/** A world where `nix flake update` moves nixpkgs from aaaaaaa to bbbbbbb. */
const updated = () => {
  const world = new World();
  world.updatedLock = Option.some(lockAt({ nixpkgs: "bbbbbbb" }));

  return world;
};

describe("updater", () => {
  it.effect("leaves GitHub alone when flake.lock is already current", () =>
    Effect.gen(function* () {
      const world = new World();

      yield* runIn(world);

      assert.deepStrictEqual(world.pushes, []);
      assert.deepStrictEqual(world.createdPrs, []);
    })
  );

  it.effect("opens a PR listing every updated input", () =>
    Effect.gen(function* () {
      const world = new World();
      world.main.set(
        "flake.lock",
        lockAt({ "home-manager": "1111111", nixpkgs: "aaaaaaa" })
      );
      world.updatedLock = Option.some(
        lockAt({ "home-manager": "2222222", nixpkgs: "bbbbbbb" })
      );
      world.agentEnabled = false;

      yield* runIn(world);

      assert.deepStrictEqual(world.pushes, [{ replace: true, sha: "c1" }]);
      assert.deepStrictEqual(
        Arr.map(world.createdPrs, (pr) => pr.title),
        ["up"]
      );
      const update = world.lastUpdate();
      assert.isTrue(update.autoMerge);
      assert.include(update.body, "`home-manager` 1111111 → 2222222");
      assert.include(update.body, "`nixpkgs` aaaaaaa → bbbbbbb");
      assert.deepStrictEqual(world.verdicts, []);
    })
  );

  it.effect("fast-forwards the open PR instead of replacing it", () =>
    Effect.gen(function* () {
      const world = new World();
      world.pr = Option.some({ number: 7, url: "https://github.test/pull/7" });
      world.updatedLock = Option.some(lockAt({ nixpkgs: "bbbbbbb" }));
      world.agentEnabled = false;

      yield* runIn(world);

      assert.deepStrictEqual(world.pushes, [{ replace: false, sha: "c1" }]);
      assert.deepStrictEqual(world.createdPrs, []);
      assert.lengthOf(world.prUpdates, 1);
    })
  );

  it.effect("replaces the branch when main conflicted with its commits", () =>
    Effect.gen(function* () {
      const world = new World();
      world.pr = Option.some({ number: 7, url: "https://github.test/pull/7" });
      world.sync = Option.some({ mode: "reset", dropped: ["abc1234"] });
      world.updatedLock = Option.some(lockAt({ nixpkgs: "bbbbbbb" }));
      world.agentEnabled = false;

      yield* runIn(world);

      assert.deepStrictEqual(world.pushes, [{ replace: true, sha: "c1" }]);
    })
  );

  describe("with the Flake fixer enabled", () => {
    it.effect("closes the repair-failed issue once the gate is green", () =>
      Effect.gen(function* () {
        const world = updated();
        world.issues = [
          {
            number: 9,
            title: "flake-update: repair failed",
            body: "",
            url: "https://github.test/issues/9",
          },
        ];

        yield* runIn(world);

        assert.deepStrictEqual(world.verdicts, ["c1"]);
        assert.deepStrictEqual(world.repairRequests, []);
        assert.deepStrictEqual(
          Arr.map(world.issueEvents, (event) => [event.action, event.title]),
          [["close", "flake-update: repair failed"]]
        );
      })
    );

    it.effect(
      "commits a code fix from the trimmed gate log and asks for review",
      () =>
        Effect.gen(function* () {
          const world = updated();
          world.gate.push(failed("build x86_64-linux", gate232));
          world.agent.push(
            edits(
              { "modules/system/config/common.nix": "{ }\n" },
              {
                summary:
                  "drop boot.initrd options removed with scripted stage 1",
              }
            )
          );

          yield* runIn(world);

          const [request] = world.repairRequests;
          assert.isDefined(request);
          assert.include(request.failures, "boot.initrd.systemd.enable");
          assert.include(
            request.failures,
            "### build x86_64-linux (gram, harpe, warpe)"
          );
          assert.notInclude(request.failures, "Runner Image");
          assert.include(request.changes, "nixpkgs aaaaaaa→bbbbbbb");

          assert.deepStrictEqual(world.verdicts, ["c1", "c2"]);
          assert.deepStrictEqual(world.pushes.at(-1), {
            replace: false,
            sha: "c2",
          });
          assert.strictEqual(
            world.head.get("modules/system/config/common.nix"),
            "{ }\n"
          );
          const update = world.lastUpdate();
          assert.isFalse(update.autoMerge);
          assert.isTrue(update.needsReview);
          assert.include(
            update.body,
            "- drop boot.initrd options removed with scripted stage 1 (round 1, needs review)"
          );
          assert.include(update.body, "`ses_test` on https://pewter.test:8444");
        })
    );

    it.effect(
      "reverts a broken input itself and keeps auto-merge for a pure revert",
      () =>
        Effect.gen(function* () {
          const world = new World();
          world.main.set(
            "flake.lock",
            lockAt({ "home-manager": "1111111", nixpkgs: "aaaaaaa" })
          );
          world.updatedLock = Option.some(
            lockAt({ "home-manager": "2222222", nixpkgs: "bbbbbbb" })
          );
          world.gate.push(failed("build x86_64-linux", gate232));
          world.agent.push(
            edits(
              // The agent's own lock edits are ignored; the Updater rebuilds
              // flake.lock from revertedInputs.
              { "flake.lock": "garbage" },
              {
                outcome: "reverted",
                revertedInputs: ["nixpkgs"],
                filesChanged: ["flake.lock"],
                summary: "nixpkgs 3ec6363 breaks every host",
              }
            )
          );

          yield* runIn(world);

          const pushed = yield* parseLock(world.head.get("flake.lock") ?? "");
          assert.strictEqual(shortRev(pushed, "nixpkgs"), "aaaaaaa");
          assert.strictEqual(shortRev(pushed, "home-manager"), "2222222");

          const update = world.lastUpdate();
          assert.isTrue(update.autoMerge);
          assert.isFalse(update.needsReview);
          assert.include(
            update.body,
            "- `nixpkgs`: nixpkgs 3ec6363 breaks every host (https://github.test/issues/100)"
          );
          assert.include(update.body, "`home-manager` 1111111 → 2222222");
          assert.notInclude(update.body, "`nixpkgs` aaaaaaa → bbbbbbb");

          const [issue] = world.issueEvents;
          assert.strictEqual(issue?.action, "create");
          assert.strictEqual(issue?.title, "flake-update: nixpkgs held back");
          assert.include(
            issue?.body,
            "Failing hosts: gram, harpe, pewter, warpe"
          );
          assert.include(issue?.body, "main-narHash=sha256-aaaaaaanixpkgs");
        })
    );

    it.effect("discards a round that touches a blocked path", () =>
      Effect.gen(function* () {
        const world = updated();
        world.gate.push(
          failed("build x86_64-linux", gate232),
          failed("build x86_64-linux", gate232)
        );
        world.agent.push(
          edits({ ".github/workflows/build-gate.yml": "on: never\n" }),
          edits({ "modules/system/config/common.nix": "{ }\n" })
        );

        yield* runIn(world);

        assert.isFalse(world.head.has(".github/workflows/build-gate.yml"));
        assert.deepStrictEqual(
          Arr.map(world.pushes, (push) => push.sha),
          ["c1", "c2"]
        );
        const feedback = world.repairRequests[1]?.feedback;
        assert.isTrue(feedback !== undefined && Option.isSome(feedback));
        assert.include(
          Option.getOrElse(feedback ?? Option.none(), () => ""),
          ".github/workflows/build-gate.yml"
        );
      })
    );

    it.effect("discards a round whose report does not match its changes", () =>
      Effect.gen(function* () {
        const world = updated();
        world.gate.push(
          failed("build x86_64-linux", gate232),
          failed("build x86_64-linux", gate232)
        );
        world.agent.push(
          edits(
            { "modules/a.nix": "a\n", "modules/b.nix": "b\n" },
            { filesChanged: ["modules/a.nix"] }
          ),
          edits({ "modules/a.nix": "a\n" })
        );

        yield* runIn(world);

        assert.isFalse(world.head.has("modules/b.nix"));
        assert.strictEqual(world.head.get("modules/a.nix"), "a\n");
        assert.include(
          Option.getOrElse(
            world.repairRequests[1]?.feedback ?? Option.none(),
            () => ""
          ),
          "modules/b.nix"
        );
      })
    );

    it.effect("stops after the round cap and comments on the open issue", () =>
      Effect.gen(function* () {
        const world = updated();
        world.issues = [
          {
            number: 9,
            title: "flake-update: repair failed",
            body: "",
            url: "https://github.test/issues/9",
          },
        ];

        for (const round of [1, 2, 3, 4]) {
          world.gate.push(failed("build x86_64-linux", gate232));
          world.agent.push(edits({ "modules/a.nix": `${round}\n` }));
        }

        yield* runIn(world);

        assert.lengthOf(world.repairRequests, 3);
        const last = world.issueEvents.at(-1);
        assert.strictEqual(last?.action, "comment");
        assert.strictEqual(last?.title, "flake-update: repair failed");
        assert.include(last?.body, "still red after 3 rounds");
        assert.include(
          world.lastUpdate().body,
          "Repair rounds this run: 3 of 3."
        );
      })
    );

    it.effect("reports an unavailable model without trying another", () =>
      Effect.gen(function* () {
        const world = updated();
        world.gate.push(failed("build x86_64-linux", gate232));
        world.agent.push(() =>
          Effect.fail(
            AgentError.make({
              reason: "unavailable",
              message: "free usage limit reached",
              session: "ses_limit",
            })
          )
        );

        yield* runIn(world);

        const [issue] = world.issueEvents;
        assert.strictEqual(issue?.title, "flake-update: repair failed");
        assert.include(issue?.body, "could not run: free usage limit reached");
        assert.include(issue?.body, "`opencode/deepseek-v4.1-flash-free`");
        assert.include(issue?.body, "`ses_limit` on https://pewter.test:8444");
        assert.lengthOf(world.repairRequests, 1);
      })
    );

    it.effect("does not try to repair checks outside the Build gate", () =>
      Effect.gen(function* () {
        const world = updated();
        world.gate.push(failed("flake-update-scope", ""));

        yield* runIn(world);

        assert.deepStrictEqual(world.repairRequests, []);
        assert.include(
          world.issueEvents[0]?.body,
          "checks outside the Build gate failed: flake-update-scope"
        );
      })
    );

    it.effect("stops when the Flake fixer gives up", () =>
      Effect.gen(function* () {
        const world = updated();
        world.gate.push(failed("build x86_64-linux", gate232));
        world.agent.push(
          edits(
            {},
            { outcome: "gave-up", summary: "upstream kernel is broken" }
          )
        );

        yield* runIn(world);

        assert.include(
          world.issueEvents[0]?.body,
          "gave up: upstream kernel is broken"
        );
        assert.deepStrictEqual(
          Arr.map(world.pushes, (push) => push.sha),
          ["c1"]
        );
      })
    );

    it.effect(
      "reports the deadline instead of running into the unit timeout",
      () =>
        Effect.gen(function* () {
          const world = updated();
          world.gateHangs = true;

          const fiber = yield* Effect.forkChild(runIn(world));
          yield* TestClock.adjust(Duration.hours(12));
          yield* Fiber.join(fiber);

          assert.include(world.issueEvents[0]?.body, "hit the 11h limit");
        })
    );
  });

  it.effect("closes held-back issues once main has a newer revision", () =>
    Effect.gen(function* () {
      const world = new World();
      world.issues = [
        {
          number: 5,
          title: "flake-update: nixpkgs held back",
          body: "<!-- flake-update main-narHash=sha256-0000000nixpkgs -->",
          url: "https://github.test/issues/5",
        },
        {
          number: 6,
          title: "flake-update: home-manager held back",
          body: "<!-- flake-update main-narHash=sha256-1111111home-manager -->",
          url: "https://github.test/issues/6",
        },
      ];
      world.main.set(
        "flake.lock",
        lockAt({ "home-manager": "1111111", nixpkgs: "aaaaaaa" })
      );

      yield* runIn(world);

      assert.deepStrictEqual(
        Arr.map(world.issueEvents, (event) => [event.action, event.title]),
        [["close", "flake-update: nixpkgs held back"]]
      );
    })
  );
});
