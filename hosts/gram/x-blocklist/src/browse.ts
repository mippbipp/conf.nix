import type { PlatformError } from "effect";
import { Context, Effect, Layer, Schema, Stream, String as Str } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A `browse` tool call failed, or the CLI couldn't start. */
export class BrowseError extends Schema.TaggedError<
  BrowseError,
  { readonly brand: unique symbol }
>()("BrowseError", {
  message: Schema.String,
  tool: Schema.String,
}) {}

// Tool arguments are plain JSON values, so stringify cannot throw.
// oxlint-disable-next-line effecttsgo/global-json -- see above
const toJson = (value: Schema.Json): string => JSON.stringify(value);

const collect = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) => Stream.mkString(Stream.decodeText(stream));

/**
 * The browse CLI's tools, which drive the logged-in Chrome through the
 * browse relay: `browse <tool> --json '<args>'`.
 */
export class Browse extends Context.Service<
  Browse,
  {
    /** Calls one tool and returns the JSON it printed. */
    readonly call: (
      tool: string,
      args: Schema.Json
    ) => Effect.Effect<string, BrowseError>;
  }
>()("x-blocklist/browse") {
  public static readonly layer = Layer.effect(
    Browse,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const exec = (tool: string, args: Schema.Json) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("browse", [tool, "--json", toJson(args)], {
              extendEnv: true,
              stdin: "ignore",
            })
          );

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          );

          return { exitCode: Number(exitCode), stderr, stdout };
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            BrowseError.make({ message: String(cause), tool })
          )
        );

      const call = Effect.fn("Browse.call")(function* (
        tool: string,
        args: Schema.Json
      ) {
        const output = yield* exec(tool, args);

        // browse prints a failed call's error on stdout.
        if (output.exitCode !== 0) {
          return yield* BrowseError.make({
            message: Str.trim(`${output.stdout}\n${output.stderr}`),
            tool,
          });
        }

        return output.stdout;
      });

      return Browse.of({ call });
    })
  );
}
