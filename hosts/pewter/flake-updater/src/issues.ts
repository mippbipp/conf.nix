import { Array as Arr, Option, String as Str } from "effect";

import { renderFailures } from "./repair-round.ts";
import type { CheckFailure } from "./repair-round.ts";

export const repairFailedTitle = "flake-update: repair failed";

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
  /** From `heldBackMarker`, so a later run can tell when the update landed. */
  readonly marker: string;
  readonly failures: readonly CheckFailure[];
  readonly session: string;
}

export const renderHeldBackIssue = (report: HeldBackReport): string => {
  const hosts = failingHosts(report.failures);

  return Arr.join(
    [
      report.marker,
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
      "The Updater retries this input every week and closes this issue once main's lock entry for it changes.",
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
