import { Array as Arr, Option, String as Str } from "effect";

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
