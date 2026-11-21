import { Array as Arr, Data, Effect, Option, Order, Result } from "effect";

import { Agent } from "./agent.ts";
import type { AgentError, RepairReport, RepairResult } from "./agent.ts";
import { formatFixerCommit } from "./branch-state.ts";
import { renderFailures } from "./gate-log.ts";
import type { CheckFailure } from "./gate-log.ts";
import { Git, readFlakeLock } from "./git.ts";
import type { ImportedTree } from "./git.ts";
import { GitHub } from "./github.ts";
import type { PullRequest } from "./github.ts";
import {
  changedInputs,
  classifyLockChange,
  formatLock,
  revertInputs,
} from "./lock.ts";
import type { FlakeLock } from "./lock.ts";
import { isBlocked } from "./scope.ts";

export interface RoundRequest {
  readonly failures: ReadonlyArray<CheckFailure>;
  /** Why the previous round was discarded, if it was. */
  readonly feedback: Option.Option<string>;
  readonly main: FlakeLock;
  readonly pr: PullRequest;
  readonly round: number;
  /** Continue this Flake fixer session; the first round opens one. */
  readonly session: Option.Option<string>;
}

export type RoundOutcome = Data.TaggedEnum<{
  AgentFailed: { readonly error: AgentError };
  /** Committed on top of the branch and pushed. */
  Committed: {
    /** Inputs now held back at main's revision. */
    readonly reverted: ReadonlyArray<string>;
    readonly reviewRequired: boolean;
    readonly session: string;
    readonly sha: string;
    readonly summary: string;
  };
  /** Nothing committed; the reason goes into the next round's prompt. */
  Discarded: { readonly reason: string; readonly session: string };
  GaveUp: { readonly session: string; readonly summary: string };
}>;

export const roundOutcome = Data.taggedEnum<RoundOutcome>();

export type CommittedRound = Data.TaggedEnum.Value<RoundOutcome, "Committed">;

const sorted = (paths: ReadonlyArray<string>) =>
  Arr.join(Arr.sort(paths, Order.String), ", ");

const withoutLock = (paths: ReadonlyArray<string>) =>
  Arr.filter(paths, (path) => path !== "flake.lock");

/**
 * Why the Updater must discard a round, if it must. A discarded round is
 * never committed; the agent hears the reason in the next round.
 */
const rejection = (
  imported: ImportedTree,
  report: RepairReport
): Option.Option<string> => {
  const { files } = imported;

  if (Arr.isReadonlyArrayEmpty(files)) {
    return Option.some(
      "The round changed no files and requested no reverts that changed flake.lock."
    );
  }

  const blocked = Arr.filter(files, isBlocked);

  if (Arr.isReadonlyArrayNonEmpty(blocked)) {
    return Option.some(
      `The round changed paths the Flake fixer may not touch (${sorted(blocked)}), so it was discarded.`
    );
  }

  // A nested repository imports as a gitlink pinning any commit, which no
  // blocked path or report check can vet.
  if (Arr.isReadonlyArrayNonEmpty(imported.gitlinks)) {
    return Option.some(
      `The round added or moved submodule commits (${sorted(imported.gitlinks)}), so it was discarded. Do not create git repositories in the workspace.`
    );
  }

  const code = sorted(withoutLock(files));
  const reported = sorted(withoutLock(report.filesChanged));

  if (code !== reported) {
    return Option.some(
      `The report listed [${reported}] but the workspace changed [${code}], so the round was discarded.`
    );
  }

  return Option.none();
};

const describeChanges = (main: FlakeLock, head: FlakeLock) =>
  Arr.join(
    Arr.map(
      changedInputs(main, head),
      (change) => `${change.name} ${change.from}→${change.to}`
    ),
    "\n"
  );

/**
 * Rebuilds flake.lock from the requested reverts, reads the workspace back
 * and commits it, unless the round has to be discarded.
 */
const commitRound = Effect.fn("RepairRound.commitRound")(function* (
  request: RoundRequest,
  before: FlakeLock,
  repaired: RepairResult
) {
  const git = yield* Git;
  const github = yield* GitHub;
  const agent = yield* Agent;
  const { report, session } = repaired;
  const lock = revertInputs(before, request.main, report.revertedInputs);
  const imported = yield* git.importTree(agent.workspace, formatLock(lock));
  const rejected = rejection(imported, report);

  if (Option.isSome(rejected)) {
    yield* Effect.logWarning(rejected.value);

    return roundOutcome.Discarded({ reason: rejected.value, session });
  }

  const change = classifyLockChange(request.main, before, lock);

  const reviewRequired =
    Arr.isReadonlyArrayNonEmpty(withoutLock(imported.files)) ||
    !change.onlyReverts;

  const sha = yield* git.commitTree(
    imported.tree,
    formatFixerCommit(report.summary, {
      reverted: change.reverted,
      reviewRequired,
      round: `${request.round}`,
      session,
    })
  );

  if (reviewRequired) {
    yield* github.holdForReview(request.pr);
  }

  yield* git.push(false);

  return roundOutcome.Committed({
    reverted: change.reverted,
    reviewRequired,
    session,
    sha,
    summary: report.summary,
  });
});

/**
 * One Flake fixer round on the branch's HEAD: export the workspace, run the
 * agent, then commit and push what it did or say why it was not kept.
 */
export const repairRound = Effect.fn("RepairRound.run")(function* (
  request: RoundRequest
) {
  const agent = yield* Agent;
  const git = yield* Git;
  const before = yield* readFlakeLock("HEAD");

  yield* git.exportTree(agent.workspace);

  const attempt = yield* Effect.result(
    agent.repair({
      changes: describeChanges(request.main, before),
      failures: renderFailures(request.failures),
      feedback: request.feedback,
      mainLock: formatLock(request.main),
      pr: request.pr.number,
      round: request.round,
      session: request.session,
      title: `flake-update #${request.pr.number}`,
    })
  );

  if (Result.isFailure(attempt)) {
    return roundOutcome.AgentFailed({ error: attempt.failure });
  }

  const repaired = attempt.success;

  if (repaired.report.outcome === "gave-up") {
    return roundOutcome.GaveUp({
      session: repaired.session,
      summary: repaired.report.summary,
    });
  }

  return yield* commitRound(request, before, repaired);
});
