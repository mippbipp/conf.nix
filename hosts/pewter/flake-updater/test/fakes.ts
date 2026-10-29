import {
  Array as Arr,
  Duration,
  Effect,
  Layer,
  Option,
  Record as Rec,
  String as Str,
} from "effect";

import { Agent, AgentError, RepairReport } from "../src/agent.ts";
import type { RepairRequest, RepairResult } from "../src/agent.ts";
import { Gate } from "../src/gate.ts";
import type { GateVerdict } from "../src/gate.ts";
import { Git, mainRef } from "../src/git.ts";
import type { SyncOutcome, BranchCommit } from "../src/git.ts";
import { GitHub } from "../src/github.ts";
import type { Issue, PullRequest, PullRequestUpdate } from "../src/github.ts";
import { Nix } from "../src/nix.ts";
import { Settings } from "../src/settings.ts";

/** Files of one tree, path to content. */
export type Tree = Map<string, string>;

const lockedNode = (name: string, rev: string) => ({
  flake: true,
  inputs: { nixpkgs: ["nixpkgs"] },
  locked: {
    lastModified: 1_793_000_000,
    narHash: `sha256-${rev}${name}`,
    owner: "upstream",
    repo: name,
    rev: `${rev}${Str.repeat(33)("0")}`,
    type: "github",
  },
  original: { owner: "upstream", repo: name, type: "github" },
});

/** A flake.lock whose root inputs sit at the given seven-character revisions. */
export const lockAt = (revs: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(
    {
      nodes: {
        ...Rec.map(revs, (rev, name) => lockedNode(name, rev)),
        root: { inputs: Rec.map(revs, (_rev, name) => name) },
      },
      root: "root",
      version: 7,
    },
    null,
    2
  )}\n`;

export type AgentStep = (
  request: RepairRequest,
  workspace: Tree
) => Effect.Effect<RepairResult, AgentError>;

export interface IssueEvent {
  readonly action: "create" | "comment" | "close";
  readonly title: string;
  readonly body: string;
}

/** Everything the fake services read and record, inspected by tests. */
export class World {
  public main: Tree = new Map([["flake.lock", lockAt({ nixpkgs: "aaaaaaa" })]]);
  public head: Tree = new Map(this.main);
  public working: Tree = new Map(this.main);
  public workspace: Tree = new Map();
  public readonly trees = new Map<string, Tree>();
  public commits: BranchCommit[] = [];
  public sync: Option.Option<SyncOutcome> = Option.none();
  /** flake.lock as `nix flake update` would write it. */
  public updatedLock: Option.Option<string> = Option.none();
  public readonly pushes: { replace: boolean; sha: string }[] = [];
  public pr: Option.Option<PullRequest> = Option.none();
  public readonly createdPrs: { title: string; body: string }[] = [];
  public readonly prUpdates: PullRequestUpdate[] = [];
  public issues: Issue[] = [];
  public readonly issueEvents: IssueEvent[] = [];
  public readonly gate: GateVerdict[] = [];
  public readonly verdicts: string[] = [];
  public readonly agent: AgentStep[] = [];
  public readonly repairRequests: RepairRequest[] = [];
  /** Directories exportTree and importTree were given, in order. */
  public readonly workspaceDirs: string[] = [];
  public agentEnabled = true;
  public gateHangs = false;
  private readonly counters = new Map<string, number>();

  public next(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;

    this.counters.set(prefix, count);

    return `${prefix}${count}`;
  }

  public sha(): string {
    return this.commits.at(-1)?.sha ?? "main";
  }

  public lastUpdate(): PullRequestUpdate {
    const update = this.prUpdates.at(-1);

    if (update === undefined) {
      throw new Error("the PR was never updated");
    }

    return update;
  }
}

const readLock = (world: World, rev: string) => {
  const tree =
    rev === mainRef
      ? world.main
      : rev === "HEAD"
        ? world.head
        : world.trees.get(rev);

  return Effect.succeed(tree?.get("flake.lock") ?? "");
};

const diffPaths = (a: Tree, b: Tree) => {
  const paths = Arr.dedupe([...a.keys(), ...b.keys()]);
  const changed = Arr.filter(paths, (path) => a.get(path) !== b.get(path));

  return Arr.sort(changed, Str.Order);
};

/** Workspace content standing for a nested repository at a commit. */
export const gitlinkPrefix = "gitlink:";

const gitlinkPaths = (a: Tree, b: Tree) =>
  Arr.filter(diffPaths(a, b), (path) =>
    Str.startsWith(gitlinkPrefix)(b.get(path) ?? "")
  );

const gitLayer = (world: World) =>
  Layer.succeed(Git)({
    prepare: Effect.void,
    sync: (continuing) =>
      Effect.sync(() => {
        const outcome = Option.getOrElse(world.sync, (): SyncOutcome => ({
          mode: continuing ? "continued" : "fresh",
          dropped: [],
        }));

        if (outcome.mode !== "continued") {
          world.head = new Map(world.main);
          world.commits = [];
        }

        world.working = new Map(world.head);

        return outcome;
      }),
    commitLock: (message) =>
      Effect.sync(() => {
        if (world.working.get("flake.lock") === world.head.get("flake.lock")) {
          return false;
        }

        world.head = new Map(world.working);
        world.commits.push({ sha: world.next("c"), message });

        return true;
      }),
    readLock: (rev) => readLock(world, rev),
    head: Effect.sync(() => world.sha()),
    branchCommits: Effect.sync(() => [...world.commits]),
    changedFromMain: Effect.sync(() => diffPaths(world.main, world.head)),
    push: (replace) =>
      Effect.sync(() => {
        world.pushes.push({ replace, sha: world.sha() });
      }),
    exportTree: (dir) =>
      Effect.sync(() => {
        world.workspaceDirs.push(dir);
        world.workspace = new Map(world.head);
      }),
    importTree: (dir, lock) =>
      Effect.sync(() => {
        world.workspaceDirs.push(dir);
        const tree = new Map([...world.workspace, ["flake.lock", lock]]);
        const id = world.next("t");
        world.trees.set(id, tree);

        return {
          tree: id,
          files: diffPaths(world.head, tree),
          gitlinks: gitlinkPaths(world.head, tree),
        };
      }),
    commitTree: (tree, message) =>
      Effect.sync(() => {
        world.head = new Map(world.trees.get(tree));
        const sha = world.next("c");
        world.commits.push({ sha, message });

        return sha;
      }),
  });

const githubLayer = (world: World) =>
  Layer.succeed(GitHub)({
    openPr: Effect.sync(() => world.pr),
    createPr: (title, body) =>
      Effect.sync(() => {
        const pr = { number: 42, url: "https://github.test/pull/42" };
        world.pr = Option.some(pr);
        world.createdPrs.push({ title, body });

        return pr;
      }),
    updatePr: (_pr, update) =>
      Effect.sync(() => {
        world.prUpdates.push(update);
      }),
    openIssues: Effect.sync(() => [...world.issues]),
    createIssue: (title, body) =>
      Effect.sync(() => {
        const number = 100 + world.issueEvents.length;

        const issue = {
          number,
          title,
          body,
          url: `https://github.test/issues/${number}`,
        };

        world.issues.push(issue);
        world.issueEvents.push({ action: "create", title, body });

        return issue;
      }),
    commentIssue: (issue, body) =>
      Effect.sync(() => {
        world.issueEvents.push({ action: "comment", title: issue.title, body });
      }),
    closeIssue: (issue, comment) =>
      Effect.sync(() => {
        world.issues = Arr.filter(world.issues, (open) => open !== issue);
        world.issueEvents.push({
          action: "close",
          title: issue.title,
          body: comment,
        });
      }),
  });

const nixLayer = (world: World) =>
  Layer.succeed(Nix)({
    update: Effect.sync(() => {
      if (Option.isSome(world.updatedLock)) {
        world.working.set("flake.lock", world.updatedLock.value);
      }
    }),
  });

const gateLayer = (world: World) =>
  Layer.succeed(Gate)({
    verdict: (_pr, sha) =>
      world.gateHangs
        ? Effect.never
        : Effect.sync(() => {
            world.verdicts.push(sha);

            return world.gate.shift() ?? { failed: [] };
          }),
  });

export const fixerWorkspace = "/var/lib/flake-fixer/work";

const agentLayer = (world: World) =>
  Layer.succeed(Agent)({
    workspace: fixerWorkspace,
    repair: (request) =>
      Effect.suspend(() => {
        world.repairRequests.push(request);
        const step = world.agent.shift();

        if (step === undefined) {
          return Effect.fail(
            AgentError.make({
              reason: "failed",
              message: "test agent has no step left",
            })
          );
        }

        return step(request, world.workspace);
      }),
  });

export const settings = {
  maxRounds: 3,
  deadline: Duration.hours(11),
  model: "opencode/deepseek-v4.1-flash-free",
  sessionUrl: "https://pewter.test:8444",
};

const services = (world: World) =>
  Layer.mergeAll(
    gitLayer(world),
    githubLayer(world),
    nixLayer(world),
    gateLayer(world),
    Layer.succeed(Settings)(settings)
  );

/** The fake services with the Flake fixer. */
export const fixerLayer = (world: World) =>
  Layer.merge(services(world), agentLayer(world));

/** The fake services; the Flake fixer is provided only when enabled. */
export const worldLayer = (world: World) =>
  world.agentEnabled ? fixerLayer(world) : services(world);

/** An agent round that writes files into the workspace and reports them. */
export const edits =
  (
    files: Readonly<Record<string, string>>,
    report: Partial<{
      outcome: "fixed" | "reverted" | "gave-up";
      revertedInputs: readonly string[];
      filesChanged: readonly string[];
      summary: string;
    }> = {}
  ): AgentStep =>
  (request, workspace) =>
    Effect.sync(() => {
      for (const [path, content] of Rec.toEntries(files)) {
        workspace.set(path, content);
      }

      return {
        session: Option.getOrElse(request.session, () => "ses_test"),
        report: RepairReport.make({
          outcome: report.outcome ?? "fixed",
          revertedInputs: report.revertedInputs ?? [],
          filesChanged: report.filesChanged ?? Rec.keys(files),
          summary: report.summary ?? "fix the build",
        }),
      };
    });

export const failed = (name: string, log: string): GateVerdict => ({
  failed: [{ name, url: `https://github.test/job/${name}`, log }],
});
