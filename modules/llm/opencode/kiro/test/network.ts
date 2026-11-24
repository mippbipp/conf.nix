// The fake network a test file's HTTP goes to: each test sets how it answers,
// and an answer that fails is a transport error, as fetch's would be.

import { Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";

type Request = HttpClientRequest.HttpClientRequest;

// Unanswered is a request the fake network has no answer for
export class Unanswered extends Schema.TaggedError<
  Unanswered,
  { readonly brand: unique symbol }
>()("Unanswered", { message: Schema.String }) {}
export const unanswered = (message: string) =>
  Effect.fail(Unanswered.make({ message }));

export type Answer = (request: Request) => Effect.Effect<Response, Unanswered>;

export const offline: Answer = () => unanswered("no network in tests");

export function fakeNetwork() {
  const net = { answer: offline };
  const client = HttpClient.make((request) =>
    Effect.suspend(() => net.answer(request)).pipe(
      Effect.mapBoth({
        onFailure: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ cause, request }),
          }),
        onSuccess: (res) => HttpClientResponse.fromWeb(request, res),
      })
    )
  );
  return Object.assign(net, {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    // reset puts the network back offline after effect
    reset: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.ensuring(
        effect,
        Effect.sync(() => {
          net.answer = offline;
        })
      ),
  });
}

// recording reads each request's JSON body into record, then answers with body
export const recording =
  (record: (request: Request, json: unknown) => void, body: unknown) =>
  (request: Request) =>
    jsonOf(request).pipe(
      Effect.flatMap((json) => {
        record(request, json);
        return reply(body);
      })
    );

// reply is an answer of body as JSON
export const reply = (body: unknown, init?: ResponseInit) =>
  Effect.succeed(Response.json(body, init));

const decoder = new TextDecoder();
// textOf is a request's body as text; the plugin sends bodies as bytes
export const textOf = (request: Request) =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? decoder.decode(request.body.body)
    : "";
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
// jsonOf is a request's JSON body
export const jsonOf = (request: Request) =>
  request.pipe(textOf, decodeJson, Effect.orDie);
export const pathOf = (request: Request) => new URL(request.url).pathname;
export const param = (request: Request, name: string) =>
  Option.getOrUndefined(UrlParams.getFirst(request.urlParams, name));
