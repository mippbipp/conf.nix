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
export const field = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

// isOk is whether an HTTP status is a 2xx. HttpClientResponse.filterStatusOk
// would fail with the response behind an HttpClientError, and each caller
// reads the status and body itself.
export const isOk = (status: number) => status >= 200 && status <= 299;

// send makes a request with tracing off: OpenCode's tracer then adds no
// headers to what Kiro and AWS are sent, and records none of them. A
// request with a deadline fails with a TimeoutError that names the host if
// the headers take longer; a caller that reads the body puts its own
// deadline around both.
export const send = (request: HttpClientRequest.HttpClientRequest, seconds?: number) =>
  HttpClient.execute(request).pipe(
    seconds === undefined ? (effect) => effect : deadline(request.url, seconds),
    Effect.provideService(Tracer.DisablePropagation, true)
  );

// deadline fails an effect that runs longer than seconds with a TimeoutError
// that names url's host
export const deadline =
  (url: string, seconds: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(effect, {
      duration: `${seconds} seconds`,
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(`${new URL(url).host} didn't answer within ${seconds} seconds`)
        ),
    });
