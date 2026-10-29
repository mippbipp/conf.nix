import { Array as Arr, Option, String as Str } from "effect";

import type { BranchState } from "./branch-state.ts";

/** This run's repair progress, beside what the branch itself records. */
export interface RunProgress {
  readonly rounds: number;
  readonly maxRounds: number;
  readonly session: Option.Option<string>;
}

const section = (title: string, lines: readonly string[]) =>
  Arr.isReadonlyArrayNonEmpty(lines) ? [`## ${title}`, "", ...lines, ""] : [];

export const renderPrBody = (
  state: BranchState,
  progress: RunProgress
): string => {
  // Same revision on both sides means only the input's own inputs moved.
  const updated = Arr.map(state.updated, (change) =>
    change.from === change.to
      ? `- \`${change.name}\` ${change.to} (its inputs changed)`
      : `- \`${change.name}\` ${change.from} → ${change.to}`
  );

  const heldBack = Arr.map(state.heldBack, (input) => {
    const link = Option.match(input.issue, {
      onNone: () => "",
      onSome: (url) => ` (${url})`,
    });

    return `- \`${input.input}\`: ${input.reason}${link}`;
  });

  const commits = Arr.map(state.fixerCommits, (commit) => {
    const review = commit.reviewRequired ? ", needs review" : "";

    return `- ${commit.subject} (round ${commit.round}${review})`;
  });

  const rounds =
    progress.rounds > 0
      ? [
          `Repair rounds this run: ${progress.rounds} of ${progress.maxRounds}.`,
          ...Option.match(progress.session, {
            onNone: () => [],
            onSome: (session) => [`Session: ${session}`],
          }),
          "",
        ]
      : [];

  const review = state.needsReview
    ? [
        "**Needs review.** The Flake fixer changed more than reverting inputs, so auto-merge is off. Review its commits and merge by hand.",
        "",
      ]
    : [];

  return Str.trimEnd(
    Arr.join(
      [
        "Automated flake input update from the Updater on pewter.",
        "",
        ...review,
        ...section("Updated inputs", updated),
        ...section("Held-back inputs", heldBack),
        ...section("Flake fixer commits", commits),
        ...rounds,
      ],
      "\n"
    )
  );
};
