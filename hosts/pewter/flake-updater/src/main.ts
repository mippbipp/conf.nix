import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  String as Str,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { Shell } from "./command.ts";
import * as AgentLive from "./live/agent.ts";
import * as GateLive from "./live/gate.ts";
import * as GitLive from "./live/git.ts";
import * as GitHubLive from "./live/github.ts";
import * as LocalGate from "./live/local-gate.ts";
import * as NixLive from "./live/nix.ts";
import { formatLock, parseLock, revertInputs } from "./lock.ts";
import { defaultDeadline, Host, Settings } from "./settings.ts";
import { run } from "./updater.ts";

const flags = {
  repoDir: Flag.String("repo-dir").pipe(
    Flag.withDescription("The Updater's checkout"),
    Flag.withDefault("/var/lib/flake-updater")
  ),
  repo: Flag.String("repo").pipe(
    Flag.withDescription("GitHub repository as owner/name"),
    Flag.withDefault("mippbipp/conf.nix")
  ),
  tokenFile: Flag.String("token-file").pipe(
    Flag.withDescription("File holding the GitHub token"),
    Flag.withDefault("/run/secrets/github_token")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Update locally and evaluate instead of pushing; read GitHub but change nothing there"
    ),
    Flag.withDefault(false)
  ),
  agent: Flag.Boolean("agent").pipe(
    Flag.withDescription("Run Flake fixer rounds when the gate is red"),
    Flag.withDefault(false)
  ),
  agentUrl: Flag.String("agent-url").pipe(
    Flag.withDefault("http://127.0.0.1:4097")
  ),
  agentPasswordFile: Flag.String("agent-password-file").pipe(
    Flag.withDefault("/var/lib/flake-updater/fixer-password")
  ),
  agentName: Flag.String("agent-name").pipe(Flag.withDefault("flake-fixer")),
  model: Flag.String("model").pipe(
    Flag.withDefault("opencode/deepseek-v4.1-flash-free")
  ),
  workDir: Flag.String("work-dir").pipe(
    Flag.withDefault("/var/lib/flake-fixer/work")
  ),
  contextDir: Flag.String("context-dir").pipe(
    Flag.withDefault("/var/lib/flake-fixer/context")
  ),
  sessionUrl: Flag.String("session-url").pipe(
    Flag.withDescription("Where a person opens Flake fixer sessions"),
    Flag.withDefault("the flake-fixer opencode server")
  ),
  maxRounds: Flag.Int("max-rounds").pipe(Flag.withDefault(3)),
};

type Flags = Command.Command.Config.Infer<typeof flags>;

const readSecret = Effect.fn("readSecret")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  return Redacted.make(Str.trim(yield* fs.readFileString(file)));
});

const agentLayer = Effect.fn("agentLayer")(function* (options: Flags) {
  if (!options.agent) {
    return Layer.empty;
  }

  const password = yield* readSecret(options.agentPasswordFile);

  const server = Layer.succeed(AgentLive.FixerServer)({
    url: options.agentUrl,
    password,
    agent: options.agentName,
    model: options.model,
    workDir: options.workDir,
    contextDir: options.contextDir,
    roundTimeout: Duration.hours(1),
  });

  return AgentLive.layer.pipe(
    Layer.provide(server),
    Layer.provide(FetchHttpClient.layer)
  );
});

const update = Command.make(
  "flake-updater",
  flags,
  Effect.fn("main")(function* (options) {
    const token = yield* readSecret(options.tokenFile);

    const host = Layer.succeed(Host)({
      repoDir: options.repoDir,
      repo: options.repo,
      token,
      dryRun: options.dryRun,
    });

    const settings = Layer.succeed(Settings)({
      maxRounds: options.maxRounds,
      deadline: defaultDeadline,
      model: options.model,
      sessionUrl: options.sessionUrl,
    });

    const gate = options.dryRun ? LocalGate.layer : GateLive.layer;

    const live = Layer.mergeAll(
      GitLive.layer,
      GitHubLive.layer,
      NixLive.layer,
      gate
    ).pipe(Layer.provide(Shell.layer), Layer.provide(host));

    const agent = yield* agentLayer(options);

    yield* run().pipe(Effect.provide(Layer.mergeAll(live, settings, agent)));
  })
).pipe(
  Command.withDescription(
    "Bump flake inputs and maintain the verified update PR"
  )
);

const revertLock = Command.make(
  "revert-lock",
  {
    main: Flag.String("main").pipe(
      Flag.withDescription("main's flake.lock to take revisions from")
    ),
    lock: Flag.String("lock").pipe(Flag.withDefault("flake.lock")),
    inputs: Argument.String("input").pipe(Argument.variadic({ min: 1 })),
  },
  Effect.fn("revertLock")(function* (options) {
    const fs = yield* FileSystem.FileSystem;
    const main = yield* parseLock(yield* fs.readFileString(options.main));
    const branch = yield* parseLock(yield* fs.readFileString(options.lock));

    yield* fs.writeFileString(
      options.lock,
      formatLock(revertInputs(branch, main, options.inputs))
    );
  })
).pipe(
  Command.withDescription(
    "Put inputs back at main's revisions in a flake.lock, the way the Updater applies Flake fixer reverts"
  )
);

const main = update.pipe(
  Command.withSubcommands([revertLock]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer)
);

NodeRuntime.runMain(main);
