import { Array as Arr, Option, String as Str } from "effect";

import type { FailureExcerpt } from "./gate-log.ts";
import type { FailedCheck } from "./gate.ts";
import type { Issue } from "./github.ts";

export const repairFailedTitle = "flake-update: repair failed";

export const heldBackTitle = (input: string) =>
  `flake-update: ${input} held back`;

const heldBackPattern = /^flake-update: (?<input>\S+) held back$/u;

// Records main's revision when the input was held back. A later main with a
// different revision means an update for the input has landed.
const markerPattern = /<!-- flake-update main-narHash=(?<hash>\S+) -->/u;

export interface HeldBackIssue {
  readonly issue: Issue;
  readonly input: string;
  readonly mainNarHash: string;
}

export const parseHeldBack = (issue: Issue): Option.Option<HeldBackIssue> => {
  const input = heldBackPattern.exec(issue.title)?.groups?.input;
  const hash = markerPattern.exec(issue.body)?.groups?.hash;

  return input === undefined || hash === undefined
    ? Option.none()
    : Option.some({ issue, input, mainNarHash: hash });
};

export interface CheckFailure {
  readonly check: FailedCheck;
  readonly excerpt: FailureExcerpt;
}

/** Failing checks as the agent and issues see them. */
export const renderFailures = (failures: readonly CheckFailure[]): string =>
  Arr.join(
    Arr.map(failures, ({ check, excerpt }) => {
      const text =
        excerpt.text === ""
          ? "(no Nix error block found; read the job log)"
          : excerpt.text;

      return `## ${check.name}\n${check.url}\n\n${text}`;
    }),
    "\n\n"
  );

const failingHosts = (failures: readonly CheckFailure[]) =>
  Arr.dedupe(Arr.flatMap(failures, ({ excerpt }) => excerpt.hosts));

const checkLinks = (failures: readonly CheckFailure[]) =>
  Arr.map(failures, ({ check }) => `- [${check.name}](${check.url})`);

const details = (summary: string, text: string) => [
  "<details>",
  `<summary>${summary}</summary>`,
  "",
  "```text",
  text,
  "```",
  "</details>",
];

export interface HeldBackReport {
  readonly input: string;
  readonly pr: number;
  readonly reason: string;
  readonly mainNarHash: string;
  readonly failures: readonly CheckFailure[];
  readonly session: string;
}

export const renderHeldBackIssue = (report: HeldBackReport): string => {
  const hosts = failingHosts(report.failures);

  return Arr.join(
    [
      `<!-- flake-update main-narHash=${report.mainNarHash} -->`,
      `The Flake fixer reverted \`${report.input}\` to main's revision in #${report.pr}.`,
      "",
      `Reason: ${report.reason}`,
      "",
      `Failing hosts: ${Arr.isReadonlyArrayNonEmpty(hosts) ? Arr.join(hosts, ", ") : "not attributed"}`,
      "",
      "Failing checks:",
      ...checkLinks(report.failures),
      "",
      `Session: ${report.session}`,
      "",
      "The Updater retries this input every week and closes this issue once main has a newer revision.",
      "",
      ...details("Trimmed error", renderFailures(report.failures)),
    ],
    "\n"
  );
};

export interface RepairFailure {
  readonly pr: number;
  readonly reason: string;
  readonly model: string;
  readonly failures: readonly CheckFailure[];
  readonly session: Option.Option<string>;
}

export const renderRepairFailedIssue = (failure: RepairFailure): string => {
  const failing = Arr.isReadonlyArrayNonEmpty(failure.failures)
    ? ["Failing checks:", ...checkLinks(failure.failures), ""]
    : [];

  const session = Option.match(failure.session, {
    onNone: () => [],
    onSome: (id) => [`Session: ${id}`, ""],
  });

  const trimmed = Arr.isReadonlyArrayNonEmpty(failure.failures)
    ? details("Trimmed error", renderFailures(failure.failures))
    : [];

  const text = Arr.join(
    [
      `The Flake fixer could not get the Build gate green on #${failure.pr}.`,
      "",
      `Reason: ${failure.reason}`,
      "",
      `Model: \`${failure.model}\``,
      "",
      ...failing,
      ...session,
      ...trimmed,
    ],
    "\n"
  );

  return Str.trimEnd(text);
};
