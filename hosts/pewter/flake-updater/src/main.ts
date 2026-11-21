import { BunRuntime, BunServices } from "@effect/platform-bun";
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
import { FixerServer, layer as agentLiveLayer } from "./live/agent.ts";
import { layer as gateLayer } from "./live/gate.ts";
import { layer as gitLayer } from "./live/git.ts";
import { layer as gitHubLayer } from "./live/github.ts";
import { layer as localGateLayer } from "./live/local-gate.ts";
import { layer as nixLayer } from "./live/nix.ts";
import { formatLock, parseLock, revertInputs } from "./lock.ts";
import { defaultDeadline, Host, Settings } from "./settings.ts";
import { run } from "./updater.ts";

const flags = {
  agent: Flag.Boolean("agent").pipe(
    Flag.withDescription("Run Flake fixer rounds when the gate is red"),
    Flag.withDefault(false)
  ),
  agentName: Flag.String("agent-name").pipe(Flag.withDefault("flake-fixer")),
  agentPasswordFile: Flag.String("agent-password-file").pipe(
    Flag.withDefault("/var/lib/flake-updater/fixer-password")
  ),
  agentUrl: Flag.String("agent-url").pipe(
    Flag.withDefault("http://127.0.0.1:4097")
  ),
  contextDir: Flag.String("context-dir").pipe(
    Flag.withDefault("/var/lib/flake-fixer/context")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Update locally and evaluate instead of pushing; read GitHub but change nothing there"
    ),
    Flag.withDefault(false)
  ),
  maxRounds: Flag.Int("max-rounds").pipe(Flag.withDefault(3)),
  model: Flag.String("model").pipe(
    Flag.withDefault("opencode/deepseek-v4.1-flash-free")
  ),
  repo: Flag.String("repo").pipe(
    Flag.withDescription("GitHub repository as owner/name"),
    Flag.withDefault("mippbipp/conf.nix")
  ),
  repoDir: Flag.String("repo-dir").pipe(
    Flag.withDescription("The Updater's checkout"),
    Flag.withDefault("/var/lib/flake-updater")
  ),
  sessionUrl: Flag.String("session-url").pipe(
    Flag.withDescription("Where a person opens Flake fixer sessions"),
    Flag.withDefault("the flake-fixer opencode server")
  ),
  tokenFile: Flag.String("token-file").pipe(
    Flag.withDescription("File holding the GitHub token"),
    Flag.withDefault("/run/secrets/github_token")
  ),
  workDir: Flag.String("work-dir").pipe(
    Flag.withDefault("/var/lib/flake-fixer/work")
  ),
};

type Flags = Command.Command.Config.Infer<typeof flags>;

const readSecret = Effect.fn("readSecret")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  const contents = yield* fs.readFileString(file);

  return Redacted.make(Str.trim(contents));
});

const agentLayer = Effect.fn("agentLayer")(function* (options: Flags) {
  if (!options.agent) {
    return Layer.empty;
  }

  const password = yield* readSecret(options.agentPasswordFile);

  const server = Layer.succeed(FixerServer)({
    agent: options.agentName,
    contextDir: options.contextDir,
    model: options.model,
    password,
    roundTimeout: Duration.hours(1),
    url: options.agentUrl,
    workspace: options.workDir,
  });

  return agentLiveLayer.pipe(
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
      dryRun: options.dryRun,
      repo: options.repo,
      repoDir: options.repoDir,
      token,
    });

    const settings = Layer.succeed(Settings)({
      deadline: defaultDeadline,
      maxRounds: options.maxRounds,
      model: options.model,
      sessionUrl: options.sessionUrl,
    });

    const gate = options.dryRun ? localGateLayer : gateLayer;

    const live = Layer.mergeAll(gitLayer, gitHubLayer, nixLayer, gate).pipe(
      Layer.provide(Shell.layer),
      Layer.provide(host)
    );

    const agent = yield* agentLayer(options);

    yield* run().pipe(Effect.provide([live, settings, agent]));
  })
).pipe(
  Command.withDescription(
    "Bump flake inputs and maintain the verified update PR"
  )
);

const revertLock = Command.make(
  "revert-lock",
  {
    inputs: Argument.String("input").pipe(Argument.variadic({ min: 1 })),
    lock: Flag.String("lock").pipe(Flag.withDefault("flake.lock")),
    main: Flag.String("main").pipe(
      Flag.withDescription("main's flake.lock to take revisions from")
    ),
  },
  Effect.fn("revertLock")(function* (options) {
    const fs = yield* FileSystem.FileSystem;
    const mainText = yield* fs.readFileString(options.main);
    const main = yield* parseLock(mainText);
    const branchText = yield* fs.readFileString(options.lock);
    const branch = yield* parseLock(branchText);

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
  Effect.provide(BunServices.layer)
);

BunRuntime.runMain(main);
