import {
  Array as Arr,
  Duration,
  Effect,
  Match,
  Option,
  Order,
  Ref,
  Result,
} from "effect";

import { Agent } from "./agent.ts";
import type { AgentError, RepairResult } from "./agent.ts";
import {
  deriveBranchState,
  formatFixerCommit,
  heldBackMarker,
  heldBackTitle,
} from "./branch-state.ts";
import { trimGateLog } from "./gate-log.ts";
import { Gate } from "./gate.ts";
import type { FailedCheck } from "./gate.ts";
import { Git, mainRef } from "./git.ts";
import { GitHub } from "./github.ts";
import type { PullRequest } from "./github.ts";
import {
  renderFailures,
  renderHeldBackIssue,
  renderRepairFailedIssue,
  repairFailedTitle,
} from "./issues.ts";
import type { CheckFailure } from "./issues.ts";
import {
  changedInputs,
  classifyLockChange,
  formatLock,
  parseLock,
  revertInputs,
  shortRev,
} from "./lock.ts";
import type { FlakeLock } from "./lock.ts";
import { Nix } from "./nix.ts";
import { renderPrBody } from "./pr-body.ts";
import type { RepairReport } from "./report.ts";
import { isBlocked } from "./scope.ts";
import { Settings } from "./settings.ts";
import type { UpdaterSettings } from "./settings.ts";

/** Repair progress within one run, shown in the PR body and issues. */
interface Progress {
  readonly rounds: number;
  readonly session: Option.Option<string>;
  readonly failures: readonly CheckFailure[];
  /** The latest round's summary from the Flake fixer. */
  readonly summary: string;
}

const noProgress: Progress = {
  rounds: 0,
  session: Option.none(),
  failures: [],
  summary: "",
};

const readLock = Effect.fn("Updater.readLock")(function* (rev: string) {
  const git = yield* Git;

  return yield* parseLock(yield* git.readLock(rev));
});

const sessionLink = (settings: UpdaterSettings, session: string) =>
  `\`${session}\` on ${settings.sessionUrl}`;

/** Everything the branch, both locks and the open issues record. */
const readBranch = Effect.fn("Updater.readBranch")(function* (main: FlakeLock) {
  const git = yield* Git;
  const github = yield* GitHub;

  return deriveBranchState({
    commits: yield* git.branchCommits,
    head: yield* readLock("HEAD"),
    main,
    issues: yield* github.openIssues,
  });
});

/**
 * Regenerates the PR body and merge settings from the branch itself, so a
 * run that died halfway leaves nothing the next run cannot rebuild.
 */
const syncPr = Effect.fn("Updater.syncPr")(function* (
  pr: PullRequest,
  main: FlakeLock,
  progress: Progress
) {
  const github = yield* GitHub;
  const settings = yield* Settings;
  const state = yield* readBranch(main);

  const body = renderPrBody(state, {
    rounds: progress.rounds,
    maxRounds: settings.maxRounds,
    session: Option.map(progress.session, (id) => sessionLink(settings, id)),
  });

  yield* github.updatePr(pr, { body, needsReview: state.needsReview });
});

const findIssue = Effect.fn("Updater.findIssue")(function* (title: string) {
  const github = yield* GitHub;

  return Arr.findFirst(
    yield* github.openIssues,
    (issue) => issue.title === title
  );
});

/** One open issue per subject: later reports become comments. */
const reportIssue = Effect.fn("Updater.reportIssue")(function* (
  title: string,
  body: string
) {
  const github = yield* GitHub;
  const existing = yield* findIssue(title);

  yield* Option.match(existing, {
    onNone: () => github.createIssue(title, body),
    onSome: (issue) => github.commentIssue(issue, body),
  });
});

/** Closes held-back issues whose input main has moved past. */
const closeLandedIssues = Effect.fn("Updater.closeLandedIssues")(function* (
  main: FlakeLock
) {
  const github = yield* GitHub;
  const state = yield* readBranch(main);

  for (const { issue, input } of state.landed) {
    yield* github.closeIssue(
      issue,
      `main now has \`${input}\` at ${shortRev(main, input)}, so the update landed.`
    );
  }
});

/** The PR under repair and main's lock, fixed for the whole run. */
interface Target {
  readonly pr: PullRequest;
  readonly main: FlakeLock;
}

const reportRepairFailure = Effect.fn("Updater.reportRepairFailure")(function* (
  target: Target,
  progress: Progress,
  reason: string
) {
  const settings = yield* Settings;

  yield* Effect.logWarning(`repair failed on #${target.pr.number}: ${reason}`);

  yield* reportIssue(
    repairFailedTitle,
    renderRepairFailedIssue({
      pr: target.pr.number,
      reason,
      model: settings.model,
      failures: progress.failures,
      session: Option.map(progress.session, (id) => sessionLink(settings, id)),
    })
  );
  yield* syncPr(target.pr, target.main, progress);
});

const closeRepairIssue = Effect.fn("Updater.closeRepairIssue")(function* (
  pr: PullRequest
) {
  const github = yield* GitHub;
  const existing = yield* findIssue(repairFailedTitle);

  if (Option.isSome(existing)) {
    yield* github.closeIssue(
      existing.value,
      `The Build gate is green on #${pr.number}.`
    );
  }
});

const repairableCheck = /^(?:build|checks) /u;

const sorted = (paths: readonly string[]) =>
  Arr.join(Arr.sort(paths, Order.String), ", ");

const withoutLock = (paths: readonly string[]) =>
  Arr.filter(paths, (path) => path !== "flake.lock");

/**
 * Why the Updater must discard a round, if it must. A discarded round is
 * never committed; the agent hears the reason in the next round.
 */
const rejection = (
  files: readonly string[],
  report: RepairReport
): Option.Option<string> => {
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

const runAgent = Effect.fn("Updater.runAgent")(function* (
  target: Target,
  progress: Progress,
  feedback: Option.Option<string>
) {
  const git = yield* Git;
  const agent = yield* Agent;
  const settings = yield* Settings;
  const head = yield* readLock("HEAD");

  yield* git.exportTree(settings.workDir);

  return yield* agent.repair({
    session: progress.session,
    title: `flake-update #${target.pr.number}`,
    round: progress.rounds,
    pr: target.pr.number,
    failures: renderFailures(progress.failures),
    changes: describeChanges(target.main, head),
    mainLock: formatLock(target.main),
    feedback,
  });
});

const reportHeldBack = Effect.fn("Updater.reportHeldBack")(function* (
  target: Target,
  progress: Progress,
  input: string
) {
  const settings = yield* Settings;

  const session = Option.match(progress.session, {
    onNone: () => "unknown",
    onSome: (id) => sessionLink(settings, id),
  });

  yield* reportIssue(
    heldBackTitle(input),
    renderHeldBackIssue({
      input,
      pr: target.pr.number,
      reason: progress.summary,
      marker: heldBackMarker(target.main, input),
      failures: progress.failures,
      session,
    })
  );
});

/**
 * Commits an accepted round and files a held-back issue per revert.
 * Returns the reason when the round had to be discarded instead.
 */
const commitRound = Effect.fn("Updater.commitRound")(function* (
  target: Target,
  progress: Progress,
  repaired: RepairResult
) {
  const git = yield* Git;
  const settings = yield* Settings;
  const before = yield* readLock("HEAD");

  const reverted = revertInputs(
    before,
    target.main,
    repaired.report.revertedInputs
  );

  const lock = formatLock(reverted);
  const imported = yield* git.importTree(settings.workDir, lock);
  const rejected = rejection(imported.files, repaired.report);

  if (Option.isSome(rejected)) {
    yield* Effect.logWarning(rejected.value);

    return rejected;
  }

  const change = classifyLockChange(target.main, before, reverted);

  const reviewRequired =
    Arr.isReadonlyArrayNonEmpty(withoutLock(imported.files)) ||
    !change.onlyReverts;

  yield* git.commitTree(
    imported.tree,
    formatFixerCommit(repaired.report.summary, {
      round: `${progress.rounds}`,
      session: repaired.session,
      reviewRequired,
      reverted: change.reverted,
    })
  );
  yield* git.push(false);
  yield* Effect.forEach(change.reverted, (input) =>
    reportHeldBack(target, progress, input)
  );
  yield* syncPr(target.pr, target.main, progress);

  return Option.none<string>();
});

const excerpts = (checks: readonly FailedCheck[]): readonly CheckFailure[] =>
  Arr.map(checks, (check) => ({ check, excerpt: trimGateLog(check.log) }));

const agentFailure = (error: AgentError) =>
  error.reason === "unavailable"
    ? `the Flake fixer could not run: ${error.message}`
    : `the Flake fixer failed: ${error.message}`;

/** What one pass of the repair loop decided. */
interface Step {
  /** The gate is green. */
  readonly done: boolean;
  /** Stop and report this reason. */
  readonly stop: Option.Option<string>;
  /** Why the Updater discarded the round, for the next prompt. */
  readonly feedback: Option.Option<string>;
}

const stopWith = (reason: string): Step => ({
  done: false,
  stop: Option.some(reason),
  feedback: Option.none(),
});

/** One gate verdict, and one repair round if the verdict allows it. */
const step = Effect.fn("Updater.step")(function* (
  target: Target,
  state: Ref.Ref<Progress>,
  feedback: Option.Option<string>
) {
  const git = yield* Git;
  const gate = yield* Gate;
  const settings = yield* Settings;
  const verdict = yield* gate.verdict(target.pr, yield* git.head);

  if (Arr.isReadonlyArrayEmpty(verdict.failed)) {
    yield* closeRepairIssue(target.pr);

    return { done: true, stop: Option.none(), feedback: Option.none() };
  }

  const failures = excerpts(verdict.failed);

  const current = yield* Ref.updateAndGet(state, (progress) => ({
    ...progress,
    failures,
  }));

  const outsideGate = Arr.filter(
    verdict.failed,
    (check) => !repairableCheck.test(check.name)
  );

  if (Arr.isReadonlyArrayNonEmpty(outsideGate)) {
    const names = Arr.map(outsideGate, (check) => check.name);

    return stopWith(
      `checks outside the Build gate failed: ${Arr.join(names, ", ")}`
    );
  }

  if (current.rounds >= settings.maxRounds) {
    return stopWith(
      `the Build gate is still red after ${settings.maxRounds} rounds`
    );
  }

  const round = yield* Ref.updateAndGet(state, (progress) => ({
    ...progress,
    rounds: progress.rounds + 1,
  }));

  const attempt = yield* runAgent(target, round, feedback).pipe(
    Effect.map((repaired) => Result.succeed(repaired)),
    Effect.catchTag("AgentError", (error) => Effect.succeed(Result.fail(error)))
  );

  if (Result.isFailure(attempt)) {
    const { session } = attempt.failure;

    // Keep the session so the failure issue links to what the agent tried.
    if (session !== undefined) {
      yield* Ref.update(state, (latest) => ({
        ...latest,
        session: Option.some(session),
      }));
    }

    return attempt.failure.pipe(agentFailure, stopWith);
  }

  const repaired = attempt.success;

  const progress = yield* Ref.updateAndGet(state, (latest) => ({
    ...latest,
    session: Option.some(repaired.session),
    summary: repaired.report.summary,
  }));

  if (repaired.report.outcome === "gave-up") {
    return stopWith(`the Flake fixer gave up: ${repaired.report.summary}`);
  }

  return {
    done: false,
    stop: Option.none(),
    feedback: yield* commitRound(target, progress, repaired),
  };
});

/**
 * Waits for the gate and runs repair rounds until it is green, a stop rule
 * fires, or the round cap is spent.
 */
const repair = Effect.fn("Updater.repair")(function* (
  target: Target,
  state: Ref.Ref<Progress>
) {
  let next: Step = {
    done: false,
    stop: Option.none(),
    feedback: Option.none(),
  };

  while (!next.done && Option.isNone(next.stop)) {
    next = yield* step(target, state, next.feedback);
  }

  if (Option.isSome(next.stop)) {
    yield* reportRepairFailure(target, yield* Ref.get(state), next.stop.value);
  }
});

export const run = Effect.fn("Updater.run")(function* () {
  const git = yield* Git;
  const github = yield* GitHub;
  const nix = yield* Nix;
  const settings = yield* Settings;

  yield* git.prepare;

  const existing = yield* github.openPr;
  const outcome = yield* git.sync(Option.isSome(existing));

  yield* Match.value(outcome.mode).pipe(
    Match.when("fresh", () => Effect.log("starting flake-update from main")),
    Match.when("continued", () =>
      Effect.log("continuing the open PR with main merged in")
    ),
    Match.when("reset", () =>
      Effect.logWarning(
        `main conflicts with the open PR's commits; dropped ${Arr.join(outcome.dropped, ", ")}`
      )
    ),
    Match.exhaustive
  );

  const main = yield* readLock(mainRef);

  yield* closeLandedIssues(main);
  yield* nix.update;
  yield* git.commitLock("up");

  if (Arr.isReadonlyArrayEmpty(yield* git.changedFromMain)) {
    yield* Effect.log("flake.lock is already current");

    return;
  }

  yield* git.push(outcome.mode !== "continued");

  const pr = yield* Option.match(existing, {
    onNone: () => github.createPr("up", "Automated flake input update."),
    onSome: Effect.succeed,
  });

  yield* syncPr(pr, main, noProgress);

  if (!settings.agent) {
    return;
  }

  const target = { pr, main };
  const state = yield* Ref.make(noProgress);

  yield* repair(target, state).pipe(
    Effect.timeoutOrElse({
      duration: settings.deadline,
      orElse: () =>
        Effect.flatMap(Ref.get(state), (progress) =>
          reportRepairFailure(
            target,
            progress,
            `repair work hit the ${Duration.format(settings.deadline)} limit`
          )
        ),
    })
  );
});
