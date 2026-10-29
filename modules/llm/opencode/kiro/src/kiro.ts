// What the plugin's modules share: its provider id, how long Kiro may take,
// and how they read Kiro's JSON and send it requests.

import { Cause, Effect, Schema, Tracer } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";

export const ID = "kiro";

// Kiro's reply is dropped after this long with nothing from Kiro, the
// default of kiro-cli's own watchdog (api.streamIdleHardTimeout). A 504
// that OpenCode retries.
export const IDLE_SECONDS = 300;
// how long Kiro may take to answer a request this plugin sends itself
// (the one resent with a refreshed token) before it starts the reply
export const HEADERS_SECONDS = 60;

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
