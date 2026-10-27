import { Array as Arr, Option, Order, String as Str } from "effect";

/**
 * Cuts a GitHub Actions `--log-failed` dump down to the Nix error blocks, so a
 * failing round fits the agent's context. Lines look like
 * `<job>\t<step>\t<timestamp> <text>`; the Build gate wraps each host in a
 * `##[group]build <host>` section.
 */

const maxBlockLines = 120;

const maxExcerptChars = 16_000;

const linePattern = /^(?<job>[^\t]*)\t[^\t]*\t\S+ ?(?<text>.*)$/u;

const hostGroup = /^##\[group\]build (?<host>\S+)$/u;

const storeHash = /\/nix\/store\/[0-9a-z]{32}-/gu;

export interface FailureExcerpt {
  /** Error blocks grouped by job, deduplicated across hosts. */
  readonly text: string;
  /** Hosts whose `build <host>` section contained an error. */
  readonly hosts: readonly string[];
}

interface Block {
  readonly job: string;
  readonly host: Option.Option<string>;
  readonly lines: string[];
}

interface LogLine {
  readonly job: string;
  readonly text: string;
}

const parseLine = (raw: string): LogLine => {
  const match = linePattern.exec(raw);

  return {
    job: match?.groups?.job ?? "",
    text: match?.groups?.text ?? raw,
  };
};

// Nix indents every continuation line of an error, so a block runs until the
// next unindented line.
const continues = (block: Block, line: LogLine) =>
  block.job === line.job &&
  block.lines.length < maxBlockLines &&
  (line.text === "" || /^\s/u.test(line.text));

const collectBlocks = (log: string): readonly Block[] => {
  const blocks: Block[] = [];
  const groups = new Map<string, Option.Option<string>>();
  let open = Option.none<Block>();

  for (const line of Arr.map(Str.split(log, "\n"), parseLine)) {
    if (Option.isSome(open) && continues(open.value, line)) {
      open.value.lines.push(line.text);
    } else {
      open = Option.none();

      if (Str.startsWith("##[group]")(line.text)) {
        groups.set(
          line.job,
          Option.fromNullishOr(hostGroup.exec(line.text)?.groups?.host)
        );
      } else if (Str.startsWith("##[endgroup]")(line.text)) {
        groups.set(line.job, Option.none());
      } else if (Str.startsWith("error:")(line.text)) {
        const block: Block = {
          job: line.job,
          host: groups.get(line.job) ?? Option.none(),
          lines: [line.text],
        };

        blocks.push(block);
        open = Option.some(block);
      }
    }
  }

  return blocks;
};

interface Distinct {
  readonly job: string;
  readonly error: string;
  readonly hosts: Set<string>;
}

export const trimGateLog = (log: string): FailureExcerpt => {
  const hosts = new Set<string>();
  // One entry per job and distinct error text; same-arch hosts usually fail
  // alike.
  const distinct = new Map<string, Distinct>();

  for (const block of collectBlocks(log)) {
    const joined = Str.trimEnd(Arr.join(block.lines, "\n"));
    const error = Str.replaceAll(storeHash, "/nix/store/…-")(joined);
    const key = `${block.job}\n${error}`;

    const entry = distinct.get(key) ?? {
      job: block.job,
      error,
      hosts: new Set(),
    };

    if (Option.isSome(block.host)) {
      hosts.add(block.host.value);
      entry.hosts.add(block.host.value);
    }

    distinct.set(key, entry);
  }

  let text = "";

  for (const entry of distinct.values()) {
    const scope =
      entry.hosts.size > 0 ? ` (${Arr.join([...entry.hosts], ", ")})` : "";

    const section = `### ${entry.job}${scope}\n${entry.error}\n\n`;

    if (text.length + section.length > maxExcerptChars) {
      text += "[further errors truncated]\n";
      break;
    }

    text += section;
  }

  return {
    text: Str.trimEnd(text),
    hosts: Arr.sort([...hosts], Order.String),
  };
};
