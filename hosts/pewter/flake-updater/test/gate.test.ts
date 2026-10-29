import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { Shell } from "../src/command.ts";
import { Gate, GateError } from "../src/gate.ts";
import { layer as liveGate } from "../src/live/gate.ts";
import { Host } from "../src/settings.ts";

const sha = "c1";

const pr = { number: 7, url: "https://github.test/pull/7" };

interface FakeCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
}

const passed = (name: string): FakeCheck => ({
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
});

const failing = (name: string): FakeCheck => ({
  name,
  status: "COMPLETED",
  conclusion: "FAILURE",
});

const rollup = (checks: readonly FakeCheck[]) =>
  JSON.stringify({
    headRefOid: sha,
    statusCheckRollup: Arr.map(checks, (check, index) => ({
      ...check,
      detailsUrl: `https://github.com/o/r/actions/runs/1/job/${index + 1}`,
    })),
  });

const ruleset = (contexts: readonly string[]) =>
  JSON.stringify([
    { type: "deletion", ruleset_id: 1 },
    {
      type: "pull_request",
      parameters: { required_approving_review_count: 0 },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: Arr.map(contexts, (context) => ({ context })),
      },
    },
  ]);

const required = [
  "build x86_64-linux",
  "build aarch64-linux",
  "flake-update-scope",
];

/** Canned `gh` output; the last rollup repeats once the list runs out. */
class FakeGitHub {
  public rulesetJson = ruleset(required);
  public rollups: string[] = [];
  public polls = 0;
  public readonly log =
    "build x86_64-linux\tbuild\t2026-10-26T09:28:34Z error: boom";

  public respond(args: readonly string[]): string {
    // `gh api` rejects --repo, so match the whole argv.
    if (Arr.join(args, " ") === "api repos/o/r/rules/branches/main") {
      return this.rulesetJson;
    }

    if (args[0] === "run") {
      return this.log;
    }

    this.polls += 1;

    return this.rollups[Math.min(this.polls, this.rollups.length) - 1] ?? "";
  }
}

const gateLayer = (github: FakeGitHub) => {
  const run = (_command: string, args: readonly string[]) =>
    Effect.sync(() => github.respond(args));

  const shell = Layer.succeed(Shell)({
    run,
    exec: (command, args) =>
      Effect.map(run(command, args), (stdout) => ({
        stdout,
        stderr: "",
        exitCode: 0,
      })),
  });

  const host = Layer.succeed(Host)({
    repoDir: "/var/lib/flake-updater",
    repo: "o/r",
    token: Redacted.make("token"),
    dryRun: false,
  });

  return liveGate.pipe(Layer.provide(Layer.mergeAll(shell, host)));
};

const verdict = (github: FakeGitHub) =>
  Effect.gen(function* () {
    const gate = yield* Gate;

    return yield* gate.verdict(pr, sha);
  }).pipe(Effect.provide(gateLayer(github)));

describe("live gate", () => {
  it.effect("keeps polling while a required check has not registered", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub();
      github.rollups = [
        rollup([passed("build x86_64-linux"), passed("build aarch64-linux")]),
      ];

      const fiber = yield* Effect.forkChild(verdict(github));
      yield* TestClock.adjust(Duration.minutes(5));

      assert.isUndefined(fiber.pollUnsafe());
      assert.isAbove(github.polls, 1);
      yield* Fiber.interrupt(fiber);
    })
  );

  it.effect("decides once every required check is present and done", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub();

      const builds = [
        failing("build x86_64-linux"),
        passed("build aarch64-linux"),
      ];

      github.rollups = [
        rollup(builds),
        rollup([
          ...builds,
          { name: "flake-update-scope", status: "IN_PROGRESS", conclusion: "" },
        ]),
        rollup([...builds, passed("flake-update-scope")]),
      ];

      const fiber = yield* Effect.forkChild(verdict(github));
      yield* TestClock.adjust(Duration.minutes(5));
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(github.polls, 3);
      assert.deepStrictEqual(result.failed, [
        {
          name: "build x86_64-linux",
          url: "https://github.com/o/r/actions/runs/1/job/1",
          log: github.log,
        },
      ]);
    })
  );

  it.effect("fails when main's ruleset requires no checks", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub();
      github.rulesetJson = ruleset([]);
      github.rollups = [
        rollup([passed("build x86_64-linux"), passed("build aarch64-linux")]),
      ];

      const error = yield* Effect.flip(verdict(github));

      assert.instanceOf(error, GateError);
    })
  );
});
