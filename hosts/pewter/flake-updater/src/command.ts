import type { PlatformError } from "effect";
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Schema,
  Stream,
  String as Str,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CommandError extends Schema.TaggedError<
  CommandError,
  { readonly brand: unique symbol }
>()("CommandError", {
  command: Schema.String,
  exitCode: Schema.Finite,
  stderr: Schema.String,
}) {
  public override get message(): string {
    return `${this.command} exited with ${this.exitCode}: ${this.stderr}`;
  }
}

export interface CommandOptions {
  readonly cwd?: string | undefined;
  /** Merged over the Updater's own environment. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collect = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) => Stream.mkString(Stream.decodeText(stream));

const describe = (command: string, args: readonly string[]) =>
  Arr.join([command, ...args], " ");

/** Child processes for the live layers. */
export class Shell extends Context.Service<
  Shell,
  {
    /** Runs a command to completion, whatever its exit code. */
    readonly exec: (
      command: string,
      args: readonly string[],
      options?: CommandOptions
    ) => Effect.Effect<CommandOutput, CommandError>;
    /** Runs a command and fails unless it exits 0; returns stdout. */
    readonly run: (
      command: string,
      args: readonly string[],
      options?: CommandOptions
    ) => Effect.Effect<string, CommandError>;
  }
>()("flake-updater/command/Shell") {
  public static readonly layer = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const exec = Effect.fn("Shell.exec")(
        function* (
          command: string,
          args: readonly string[],
          options: CommandOptions = {}
        ) {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              env: options.env,
              extendEnv: true,
              stdin: "ignore",
            })
          );

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          );

          return { stdout, stderr, exitCode: Number(exitCode) };
        },
        Effect.scoped,
        Effect.mapError((cause) =>
          CommandError.make({
            command: "spawn",
            exitCode: -1,
            stderr: String(cause),
          })
        )
      );

      const run = Effect.fn("Shell.run")(function* (
        command: string,
        args: readonly string[],
        options: CommandOptions = {}
      ) {
        const output = yield* exec(command, args, options);

        if (output.exitCode !== 0) {
          return yield* CommandError.make({
            command: describe(command, args),
            exitCode: output.exitCode,
            stderr: Str.trim(output.stderr),
          });
        }

        return output.stdout;
      });

      return Shell.of({ exec, run });
    })
  );
}
