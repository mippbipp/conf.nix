import {
  Array as Arr,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
  String as Str,
} from "effect";

import { Shell } from "../command.ts";
import { Gate, GateError } from "../gate.ts";
import type { FailedCheck } from "../gate.ts";
import type { PullRequest } from "../github.ts";
import { Host } from "../settings.ts";

// The rollup tags entries with __typename; the fields alone tell them apart.
const CheckRun = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  detailsUrl: Schema.String,
});

const StatusContext = Schema.Struct({
  context: Schema.String,
  state: Schema.String,
  targetUrl: Schema.String,
});

const Rollup = Schema.Struct({
  headRefOid: Schema.String,
  statusCheckRollup: Schema.Array(Schema.Union([CheckRun, StatusContext])),
});

type Check = typeof CheckRun.Type | typeof StatusContext.Type;

const failedConclusions = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

const jobUrl = /\/actions\/runs\/(?<run>\d+)\/job\/(?<job>\d+)/u;

const pollInterval = Duration.minutes(1);

interface CheckState {
  readonly name: string;
  readonly url: string;
  readonly done: boolean;
  readonly failed: boolean;
}

const describeCheck = (check: Check): CheckState =>
  "detailsUrl" in check
    ? {
        name: check.name,
        url: check.detailsUrl,
        done: check.status === "COMPLETED",
        failed: failedConclusions.has(check.conclusion),
      }
    : {
        name: check.context,
        url: check.targetUrl,
        done: check.state !== "PENDING" && check.state !== "EXPECTED",
        failed: check.state === "FAILURE" || check.state === "ERROR",
      };

const fail = (message: string) => (cause: unknown) =>
  GateError.make({ message, cause });

const describe = (args: readonly string[]) =>
  `gh ${Arr.join(Arr.take(args, 2), " ")}`;

const retryPolicy = {
  schedule: Schedule.exponential(Duration.seconds(10)),
  times: 5,
};

const decodeRollup = Schema.decodeEffect(Schema.fromJsonString(Rollup));

const isBuildCheck = (check: CheckState) =>
  Str.startsWith("build ")(check.name);

/** Polls the PR's status rollup until the Build gate has decided. */
export const layer = Layer.effect(
  Gate,
  Effect.gen(function* () {
    const host = yield* Host;
    const { run } = yield* Shell;
    const env = { GH_TOKEN: Redacted.value(host.token) };

    // GitHub's API has bad minutes; a poll should not fail the whole run.
    const gh = (args: readonly string[]) => {
      const toError = fail(describe(args));

      return run("gh", [...args, "--repo", host.repo], { env }).pipe(
        Effect.retry(retryPolicy),
        Effect.mapError(toError)
      );
    };

    const rollup = Effect.fn("Gate.rollup")(function* (pr: PullRequest) {
      const output = yield* gh([
        "pr",
        "view",
        `${pr.number}`,
        "--json",
        "headRefOid,statusCheckRollup",
      ]);

      return yield* decodeRollup(output).pipe(
        Effect.mapError(fail("reading the PR's checks"))
      );
    });

    const failedLog = (check: CheckState) => {
      const ids = jobUrl.exec(check.url)?.groups;

      if (ids?.run === undefined || ids.job === undefined) {
        return Effect.succeed("");
      }

      return gh(["run", "view", ids.run, "--job", ids.job, "--log-failed"]);
    };

    const verdict = Effect.fn("Gate.verdict")(function* (
      pr: PullRequest,
      sha: string
    ) {
      yield* Effect.log(`waiting for the Build gate on ${sha}`);

      for (;;) {
        const state = yield* rollup(pr);
        const checks = Arr.map(state.statusCheckRollup, describeCheck);

        const decided =
          state.headRefOid === sha &&
          Arr.some(checks, isBuildCheck) &&
          Arr.every(checks, (check) => check.done);

        if (decided) {
          const failed: FailedCheck[] = [];

          for (const check of Arr.filter(checks, (entry) => entry.failed)) {
            failed.push({
              name: check.name,
              url: check.url,
              log: yield* failedLog(check),
            });
          }

          return { failed };
        }

        yield* Effect.sleep(pollInterval);
      }
    });

    return Gate.of({ verdict });
  })
);
