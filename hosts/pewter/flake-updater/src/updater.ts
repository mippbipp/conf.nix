import { Array as Arr, Duration, Effect, Match, Option, Ref } from "effect";

import { Agent } from "./agent.ts";
import type { AgentError } from "./agent.ts";
import {
  deriveBranchState,
  heldBackMarker,
  heldBackTitle,
} from "./branch-state.ts";
import { Gate } from "./gate.ts";
import { Git, mainRef } from "./git.ts";
import { GitHub } from "./github.ts";
import type { PullRequest } from "./github.ts";
import {
  renderHeldBackIssue,
  renderRepairFailedIssue,
  repairFailedTitle,
} from "./issues.ts";
import { parseLock, shortRev } from "./lock.ts";
import type { FlakeLock } from "./lock.ts";
import { Nix } from "./nix.ts";
import { renderPrBody } from "./pr-body.ts";
import { readFailures, repairRound, roundOutcome } from "./repair-round.ts";
import type {
  CheckFailure,
  CommittedRound,
  RoundOutcome,
} from "./repair-round.ts";
import { Settings } from "./settings.ts";
import type { UpdaterSettings } from "./settings.ts";

/** Repair progress within one run, shown in the PR body and issues. */
interface Progress {
  readonly rounds: number;
  readonly session: Option.Option<string>;
  readonly failures: readonly CheckFailure[];
}

const noProgress: Progress = {
  rounds: 0,
  session: Option.none(),
  failures: [],
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

/** Files a held-back issue for each input a committed round reverted. */
const reportHeldBack = Effect.fn("Updater.reportHeldBack")(function* (
  target: Target,
  progress: Progress,
  committed: CommittedRound
) {
  const settings = yield* Settings;

  const session = Option.match(progress.session, {
    onNone: () => "unknown",
    onSome: (id) => sessionLink(settings, id),
  });

  yield* Effect.forEach(committed.reverted, (input) =>
    reportIssue(
      heldBackTitle(input),
      renderHeldBackIssue({
        input,
        pr: target.pr.number,
        reason: committed.summary,
        marker: heldBackMarker(target.main, input),
        failures: progress.failures,
        session,
      })
    )
  );
});

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

const carryOn = (feedback: Option.Option<string>): Step => ({
  done: false,
  stop: Option.none(),
  feedback,
});

/** Records a round's outcome and decides what the loop does next. */
const settle = Effect.fn("Updater.settle")(function* (
  target: Target,
  state: Ref.Ref<Progress>,
  outcome: RoundOutcome
) {
  // Keep the session so the failure issue links to what the agent tried.
  const session = roundOutcome.$is("AgentFailed")(outcome)
    ? Option.fromUndefinedOr(outcome.error.session)
    : Option.some(outcome.session);

  const progress = yield* Ref.updateAndGet(state, (latest) => ({
    ...latest,
    session: Option.orElse(session, () => latest.session),
  }));

  return yield* roundOutcome.$match(outcome, {
    AgentFailed: ({ error }) =>
      Effect.succeed(error.pipe(agentFailure, stopWith)),
    GaveUp: ({ summary }) =>
      Effect.succeed(stopWith(`the Flake fixer gave up: ${summary}`)),
    Discarded: ({ reason }) => Effect.succeed(carryOn(Option.some(reason))),
    Committed: (committed) =>
      Effect.gen(function* () {
        yield* reportHeldBack(target, progress, committed);
        yield* syncPr(target.pr, target.main, progress);

        return carryOn(Option.none());
      }),
  });
});

/** One gate verdict, and one repair round if the stop rules allow it. */
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

  const { failures, outsideGate } = readFailures(verdict.failed);

  const current = yield* Ref.updateAndGet(state, (progress) => ({
    ...progress,
    failures,
  }));

  if (Arr.isReadonlyArrayNonEmpty(outsideGate)) {
    return stopWith(
      `checks outside the Build gate failed: ${Arr.join(outsideGate, ", ")}`
    );
  }

  if (current.rounds >= settings.maxRounds) {
    return stopWith(
      `the Build gate is still red after ${settings.maxRounds} rounds`
    );
  }

  const round = current.rounds + 1;

  yield* Ref.update(state, (progress) => ({ ...progress, rounds: round }));

  const outcome = yield* repairRound({
    pr: target.pr.number,
    round,
    main: target.main,
    failures,
    session: current.session,
    feedback,
  });

  return yield* settle(target, state, outcome);
});

/**
 * Waits for the gate and runs repair rounds until it is green, a stop rule
 * fires, or the round cap is spent.
 */
const repair = Effect.fn("Updater.repair")(function* (
  target: Target,
  state: Ref.Ref<Progress>
) {
  let next = carryOn(Option.none());

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

  // Repair rounds run only when the Flake fixer is configured.
  const agent = yield* Effect.serviceOption(Agent);

  if (Option.isNone(agent)) {
    return;
  }

  const target = { pr, main };
  const state = yield* Ref.make(noProgress);

  yield* repair(target, state).pipe(
    Effect.provideService(Agent, agent.value),
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
