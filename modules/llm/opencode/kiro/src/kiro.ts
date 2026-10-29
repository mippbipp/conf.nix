// What the plugin's modules share: its provider id, and how they read
// Kiro's JSON and send it requests.

import { Cause, Effect, Schema, Tracer } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";

export const ID = "kiro";

// a field kiro-cli or the IDE may leave out, or write as null
export const field = <S extends Schema.Constraint>(s: S) => Schema.optional(Schema.NullOr(s));

// send makes a request with tracing off: OpenCode's tracer then adds no
// headers to what Kiro and AWS are sent, and records none of them. A
// request with a deadline fails with a TimeoutError that names the host.
export const send = (request: HttpClientRequest.HttpClientRequest, seconds?: number) =>
  HttpClient.execute(request).pipe(
    seconds === undefined
      ? (e) => e
      : Effect.timeoutOrElse({
          duration: `${seconds} seconds`,
          orElse: () =>
            Effect.fail(
              new Cause.TimeoutError(
                `${new URL(request.url).host} didn't answer within ${seconds} seconds`
              )
            ),
        }),
    Effect.provideService(Tracer.DisablePropagation, true)
  );
