import { Array as Arr, Option, String as Str } from "effect";

import type { InputChange } from "./lock.ts";

export interface HeldBack {
  readonly input: string;
  readonly reason: string;
  readonly issue: Option.Option<string>;
}

export interface FixerCommit {
  readonly subject: string;
  readonly round: string;
  readonly reviewRequired: boolean;
}

export interface PrBody {
  readonly updated: readonly InputChange[];
  readonly heldBack: readonly HeldBack[];
  readonly fixerCommits: readonly FixerCommit[];
  readonly rounds: number;
  readonly maxRounds: number;
  readonly session: Option.Option<string>;
  readonly needsReview: boolean;
}

const section = (title: string, lines: readonly string[]) =>
  Arr.isReadonlyArrayNonEmpty(lines) ? [`## ${title}`, "", ...lines, ""] : [];

export const renderPrBody = (body: PrBody): string => {
  // Same revision on both sides means only the input's own inputs moved.
  const updated = Arr.map(body.updated, (change) =>
    change.from === change.to
      ? `- \`${change.name}\` ${change.to} (its inputs changed)`
      : `- \`${change.name}\` ${change.from} → ${change.to}`
  );

  const heldBack = Arr.map(body.heldBack, (input) => {
    const link = Option.match(input.issue, {
      onNone: () => "",
      onSome: (url) => ` (${url})`,
    });

    return `- \`${input.input}\`: ${input.reason}${link}`;
  });

  const commits = Arr.map(body.fixerCommits, (commit) => {
    const review = commit.reviewRequired ? ", needs review" : "";

    return `- ${commit.subject} (round ${commit.round}${review})`;
  });

  const rounds =
    body.rounds > 0
      ? [
          `Repair rounds this run: ${body.rounds} of ${body.maxRounds}.`,
          ...Option.match(body.session, {
            onNone: () => [],
            onSome: (session) => [`Session: ${session}`],
          }),
          "",
        ]
      : [];

  const review = body.needsReview
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
