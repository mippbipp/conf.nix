import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { DgpuConfig, makeConfig, type DgpuConfigService } from "./config.js";
import { Dgpu } from "./dgpu.js";

const commonFlags = {
  registry: Flag.String("registry").pipe(
    Flag.withDescription("Registry file to read and write"),
    Flag.optional,
  ),
  applicationsDir: Flag.String("applications-dir").pipe(
    Flag.withDescription("Directory that receives generated (dGPU) entries"),
    Flag.optional,
  ),
  sourceDirs: Flag.String("source-dirs").pipe(
    Flag.withDescription("Colon-separated application directories to search"),
    Flag.optional,
  ),
};

interface CommonFlags {
  readonly registry: Option.Option<string>;
  readonly applicationsDir: Option.Option<string>;
  readonly sourceDirs: Option.Option<string>;
}

const configFromFlags = (flags: CommonFlags): DgpuConfigService => {
  const sourceDirs = Option.isSome(flags.sourceDirs)
    ? flags.sourceDirs.value.split(":").filter((dir) => dir.length > 0)
    : undefined;

  return makeConfig({
    registry: Option.getOrUndefined(flags.registry),
    applicationsDir: Option.getOrUndefined(flags.applicationsDir),
    sourceDirs,
  });
};

const runWithConfig = <A, E>(
  config: DgpuConfigService,
  program: Effect.Effect<A, E, Dgpu>,
): Effect.Effect<A, E, FileSystem.FileSystem | Path.Path> =>
  program.pipe(
    Effect.provide(Dgpu.layer),
    Effect.provideService(DgpuConfig, config),
  );

const setCommand = Command.make(
  "set",
  {
    ...commonFlags,
    entryId: Argument.String("entry-id").pipe(
      Argument.withDescription("Desktop entry id, including .desktop"),
    ),
    value: Argument.Literals("value", ["on", "off"]),
  },
  Effect.fn(function* ({ entryId, value, ...flags }) {
    yield* runWithConfig(
      configFromFlags(flags),
      Effect.gen(function* () {
        const dgpu = yield* Dgpu;
        yield* dgpu.set(entryId, value === "on");
      }),
    );
  }),
);

const root = Command.make(
  "dgpu",
  commonFlags,
  Effect.fn(function* (flags) {
    yield* runWithConfig(
      configFromFlags(flags),
      Effect.gen(function* () {
        const dgpu = yield* Dgpu;
        yield* dgpu.reconcile();
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Reconcile dGPU wrapper desktop entries, or toggle one app with `dgpu set <id> on|off`.",
  ),
  Command.withSubcommands([setCommand]),
);

NodeRuntime.runMain(
  Command.run(root, { version: "1.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
