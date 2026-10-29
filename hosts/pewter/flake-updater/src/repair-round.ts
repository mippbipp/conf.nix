import { Array as Arr, Data, Effect, Option, Order, Result } from "effect";

import { Agent } from "./agent.ts";
import type { AgentError, RepairReport, RepairResult } from "./agent.ts";
import { formatFixerCommit } from "./branch-state.ts";
import { renderFailures } from "./gate-log.ts";
import type { CheckFailure } from "./gate-log.ts";
import { Git, readFlakeLock } from "./git.ts";
import type { ImportedTree } from "./git.ts";
import {
  changedInputs,
  classifyLockChange,
  formatLock,
  revertInputs,
} from "./lock.ts";
import type { FlakeLock } from "./lock.ts";
import { isBlocked } from "./scope.ts";

export interface RoundRequest {
  readonly pr: number;
  readonly round: number;
  readonly main: FlakeLock;
  readonly failures: readonly CheckFailure[];
  /** Continue this Flake fixer session; the first round opens one. */
  readonly session: Option.Option<string>;
  /** Why the previous round was discarded, if it was. */
  readonly feedback: Option.Option<string>;
}

export type RoundOutcome = Data.TaggedEnum<{
  /** Committed on top of the branch and pushed. */
  Committed: {
    readonly sha: string;
    readonly session: string;
    readonly summary: string;
    readonly reviewRequired: boolean;
    /** Inputs now held back at main's revision. */
    readonly reverted: readonly string[];
  };
  /** Nothing committed; the reason goes into the next round's prompt. */
  Discarded: { readonly reason: string; readonly session: string };
  GaveUp: { readonly summary: string; readonly session: string };
  AgentFailed: { readonly error: AgentError };
}>;

export const roundOutcome = Data.taggedEnum<RoundOutcome>();

export type CommittedRound = Data.TaggedEnum.Value<RoundOutcome, "Committed">;

const sorted = (paths: readonly string[]) =>
  Arr.join(Arr.sort(paths, Order.String), ", ");

const withoutLock = (paths: readonly string[]) =>
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
      round: `${request.round}`,
      session,
      reviewRequired,
      reverted: change.reverted,
    })
  );

  yield* git.push(false);

  return roundOutcome.Committed({
    sha,
    session,
    summary: report.summary,
    reviewRequired,
    reverted: change.reverted,
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
      session: request.session,
      title: `flake-update #${request.pr}`,
      round: request.round,
      pr: request.pr,
      failures: renderFailures(request.failures),
      changes: describeChanges(request.main, before),
      mainLock: formatLock(request.main),
      feedback: request.feedback,
    })
  );

  if (Result.isFailure(attempt)) {
    return roundOutcome.AgentFailed({ error: attempt.failure });
  }

  const repaired = attempt.success;

  if (repaired.report.outcome === "gave-up") {
    return roundOutcome.GaveUp({
      summary: repaired.report.summary,
      session: repaired.session,
    });
  }

  return yield* commitRound(request, before, repaired);
});
