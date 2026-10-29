import { Array as Arr, Option, String as Str } from "effect";

import type { BranchCommit } from "./git.ts";
import type { Issue } from "./github.ts";
import { changedInputs, entryFingerprint, sameRevision } from "./lock.ts";
import type { FlakeLock, InputChange } from "./lock.ts";

/**
 * Flake fixer commits carry git trailers so later runs can tell, from the
 * branch alone, which commits need review and which inputs were held back.
 */
export interface FixerTrailers {
  readonly round: string;
  readonly session: string;
  readonly reviewRequired: boolean;
  readonly reverted: readonly string[];
}

export interface FixerCommitMessage {
  readonly subject: string;
  readonly trailers: FixerTrailers;
}

const prefix = "Flake-Fixer-";

const maxSubject = 72;

export const formatFixerCommit = (
  summary: string,
  trailers: FixerTrailers
): string => {
  const lines = Str.split(Str.trim(summary), "\n");
  const first = lines[0] ?? "";

  const subject =
    first.length > maxSubject
      ? `${Str.slice(0, maxSubject - 1)(first)}…`
      : first;

  const rest = Str.trim(Arr.join(Arr.drop(lines, 1), "\n"));
  const body = first === subject ? rest : Str.trim(`${first}\n${rest}`);

  return Arr.join(
    [
      `flake-fixer: ${subject}`,
      "",
      ...(body === "" ? [] : [body, ""]),
      `${prefix}Round: ${trailers.round}`,
      `${prefix}Session: ${trailers.session}`,
      `${prefix}Review: ${trailers.reviewRequired ? "required" : "none"}`,
      ...(Arr.isReadonlyArrayNonEmpty(trailers.reverted)
        ? [`${prefix}Reverted: ${Arr.join(trailers.reverted, ", ")}`]
        : []),
    ],
    "\n"
  );
};

const trailerPattern = /^Flake-Fixer-(?<key>\w+): ?(?<value>.*)$/u;

export const parseFixerCommit = (
  message: string
): Option.Option<FixerCommitMessage> => {
  const lines = Str.split(message, "\n");
  const trailers = new Map<string, string>();

  for (const line of lines) {
    const match = trailerPattern.exec(line);

    if (match?.groups !== undefined) {
      trailers.set(match.groups.key ?? "", match.groups.value ?? "");
    }
  }

  const round = trailers.get("Round");

  if (round === undefined) {
    return Option.none();
  }

  const revertedList = Str.split(trailers.get("Reverted") ?? "", ",");
  const reverted = Arr.filter(Arr.map(revertedList, Str.trim), Str.isNonEmpty);

  return Option.some({
    subject: Str.replace("flake-fixer: ", "")(lines[0] ?? ""),
    trailers: {
      round,
      session: trailers.get("Session") ?? "",
      reviewRequired: trailers.get("Review") === "required",
      reverted,
    },
  });
};

export const heldBackTitle = (input: string) =>
  `flake-update: ${input} held back`;

const heldBackPattern = /^flake-update: (?<input>\S+) held back$/u;

const markerPattern = /<!-- flake-update main-entry=(?<entry>\S+) -->/u;

/**
 * Records main's lock entry for `input` when it was held back. The issue
 * stays open until main's entry changes.
 */
export const heldBackMarker = (main: FlakeLock, input: string): string =>
  `<!-- flake-update main-entry=${entryFingerprint(main, input)} -->`;

/** What one run reads to derive the branch's state. */
export interface Branch {
  /** Non-merge commits on the branch that main does not have. */
  readonly commits: readonly BranchCommit[];
  readonly head: FlakeLock;
  readonly main: FlakeLock;
  /** Open issues labelled `automated`. */
  readonly issues: readonly Issue[];
}

export interface HeldBack {
  readonly input: string;
  /** Subject of the Flake fixer commit that reverted it. */
  readonly reason: string;
  readonly issue: Option.Option<string>;
}

/** A held-back issue whose input main has moved past since it was filed. */
export interface LandedIssue {
  readonly issue: Issue;
  readonly input: string;
}

export interface BranchState {
  readonly updated: readonly InputChange[];
  readonly heldBack: readonly HeldBack[];
  readonly fixerCommits: readonly FixerCommitMessage[];
  /** Some Flake fixer commit needs human review, so auto-merge is off. */
  readonly needsReview: boolean;
  readonly landed: readonly LandedIssue[];
}

const landedIssue = (main: FlakeLock, issue: Issue) => {
  const input = heldBackPattern.exec(issue.title)?.groups?.input;
  const entry = markerPattern.exec(issue.body)?.groups?.entry;

  return input === undefined ||
    entry === undefined ||
    entry === entryFingerprint(main, input)
    ? []
    : [{ issue, input }];
};

/** Held-back issues whose input main has moved past since they were filed. */
export const landedIssues = (
  main: FlakeLock,
  issues: readonly Issue[]
): readonly LandedIssue[] =>
  Arr.flatMap(issues, (issue) => landedIssue(main, issue));

// An input reverted in an earlier round stays held back only while the
// branch still has main's whole lock entry for it; `nix flake update`
// retries it every run.
const heldBackInputs = (
  branch: Branch,
  fixerCommits: readonly FixerCommitMessage[]
) => {
  const heldBack = new Map<string, HeldBack>();

  const issueUrl = (input: string) =>
    Option.map(
      Arr.findFirst(
        branch.issues,
        (issue) => issue.title === heldBackTitle(input)
      ),
      (issue) => issue.url
    );

  for (const commit of fixerCommits) {
    for (const input of commit.trailers.reverted) {
      if (sameRevision(branch.head, branch.main, input)) {
        heldBack.set(input, {
          input,
          reason: commit.subject,
          issue: issueUrl(input),
        });
      }
    }
  }

  return [...heldBack.values()];
};

export const deriveBranchState = (branch: Branch): BranchState => {
  const fixerCommits = Arr.flatMap(branch.commits, (commit) =>
    Option.toArray(parseFixerCommit(commit.message))
  );

  return {
    updated: changedInputs(branch.main, branch.head),
    heldBack: heldBackInputs(branch, fixerCommits),
    fixerCommits,
    needsReview: Arr.some(
      fixerCommits,
      (commit) => commit.trailers.reviewRequired
    ),
    landed: landedIssues(branch.main, branch.issues),
  };
};
