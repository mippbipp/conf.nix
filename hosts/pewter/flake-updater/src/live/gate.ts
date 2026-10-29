import {
  Array as Arr,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
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

const RequiredChecks = Schema.Array(Schema.Struct({ context: Schema.String }));

const RuleParameters = Schema.Struct({
  required_status_checks: Schema.optionalKey(RequiredChecks),
});

// Only required_status_checks rules carry the list; the other rule types are
// decoded so the filter below can drop them.
const BranchRule = Schema.Struct({
  type: Schema.String,
  parameters: Schema.optionalKey(RuleParameters),
});

type Rule = typeof BranchRule.Type;

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

const decodeRules = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(BranchRule))
);

const contextsOf = (rule: Rule) =>
  Arr.map(
    rule.parameters?.required_status_checks ?? [],
    (check) => check.context
  );

const requiredContexts = (rules: readonly Rule[]) => {
  const statusRules = Arr.filter(
    rules,
    (rule) => rule.type === "required_status_checks"
  );

  return Arr.flatMap(statusRules, contextsOf);
};

/** Polls the PR's status rollup until every check main requires has finished. */
export const layer = Layer.effect(
  Gate,
  Effect.gen(function* () {
    const host = yield* Host;
    const { run } = yield* Shell;
    const env = { GH_TOKEN: Redacted.value(host.token) };

    // GitHub's API has bad minutes; a poll should not fail the whole run.
    const request = (args: readonly string[]) => {
      const toError = fail(describe(args));

      return run("gh", args, { env }).pipe(
        Effect.retry(retryPolicy),
        Effect.mapError(toError)
      );
    };

    const gh = (args: readonly string[]) =>
      request([...args, "--repo", host.repo]);

    // Read per verdict so a ruleset edit applies on the next round.
    const required = Effect.fn("Gate.required")(function* () {
      // `gh api` takes no --repo flag.
      const output = yield* request([
        "api",
        `repos/${host.repo}/rules/branches/main`,
      ]);

      const rules = yield* decodeRules(output).pipe(
        Effect.mapError(fail("reading main's ruleset"))
      );

      const contexts = requiredContexts(rules);

      if (Arr.isReadonlyArrayEmpty(contexts)) {
        return yield* GateError.make({
          message: "main's ruleset requires no status checks",
          cause: undefined,
        });
      }

      return contexts;
    });

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
      const contexts = yield* required();

      yield* Effect.log(`waiting for ${Arr.join(contexts, ", ")} on ${sha}`);

      for (;;) {
        const state = yield* rollup(pr);
        const checks = Arr.map(state.statusCheckRollup, describeCheck);
        const names = Arr.map(checks, (check) => check.name);

        // A check from another workflow can register after the gate's own
        // checks finish, so wait until every required one is listed.
        const decided =
          state.headRefOid === sha &&
          Arr.every(contexts, (context) => Arr.contains(names, context)) &&
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
