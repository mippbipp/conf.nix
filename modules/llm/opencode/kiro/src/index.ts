// Kiro as an OpenCode 2 provider, on kiro-cli's auth.
//
// OpenCode stores nothing for it. Each request reads the token kiro-cli
// keeps in its SQLite database (the Kiro IDE's when kiro-cli isn't signed
// in), has kiro-cli refresh it when it is about to run out, and writes back
// a token refreshed here so kiro-cli carries on with it.
//
// Kiro has no API OpenCode speaks. The provider sits on OpenCode's native
// Anthropic Messages route, and two session hooks do the translating, by
// conversation.ts. http.request turns each Messages request into a call to
// Kiro's generateAssistantResponse (the API kiro-cli uses), and
// http.response turns the AWS event stream Kiro answers with back into
// Messages events.
//
// OpenCode loads this file as it is: Bun strips the types, and OpenCode
// supplies `effect` and `@opencode/plugin` itself, so the plugin may import
// only those, Bun's and Node's own modules, and the files beside it. The
// no-restricted-imports rule in ../oxlint.config.ts fails lint on any other.
//
// The sidebar (tui.tsx) shows the account's usage and what each session has
// spent, which it asks for over the RPC in rpc.ts. usage.ts answers it.

import { randomUUID } from "node:crypto";

import type { Plugin, Provider } from "@opencode/plugin/effect";
import { Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type Auth, authHeaders, KiroAccount } from "./account.ts";
import * as Conversation from "./conversation.ts";
import * as Failure from "./failure.ts";
import { Images } from "./images.ts";
import { HEADERS_SECONDS, ID, IDLE_SECONDS, send } from "./kiro.ts";
import { decodeSaved, FALLBACK, modelInfo } from "./models.ts";
import * as Usage from "./usage.ts";

const PACKAGE = "@opencode/ai/providers/anthropic";
// where the Anthropic route posts; http.request sends it on to the account's region
const BASE = "https://runtime.us-east-1.kiro.dev";
const MODELS_KEY = "models";

const runtime = (region: string) => `https://runtime.${region}.kiro.dev`;

// ---- models ----------------------------------------------------------------------

const PROVIDER: Provider.Info = {
  id: ID as Provider.ID,
  name: "Kiro",
  // available without a connection in OpenCode: the sign-in is kiro-cli's
  activation: "enabled",
  package: PACKAGE,
  settings: {
    baseURL: BASE,
    // OpenCode times the response headers up to the end of http.response,
    // which waits for Kiro's first event. At its default, 5 minutes, it
    // would cut off a slow first event before the stall check said why.
    headerTimeout: (HEADERS_SECONDS + IDLE_SECONDS) * 1000,
  },
};

// ---- the call to Kiro ------------------------------------------------------------------

// kiroCall is a generateAssistantResponse request, with kiro-cli's headers.
function kiroCall(a: Auth, body: string) {
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${randomUUID().replaceAll("-", "")}`;
  return HttpClientRequest.post(runtime(a.region) + "/generateAssistantResponse").pipe(
    HttpClientRequest.setHeaders({
      ...authHeaders(a),
      Accept: "application/vnd.amazon.eventstream",
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-invocation-id": randomUUID(),
      "amz-sdk-request": "attempt=1; max=1",
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amz-user-agent": ua,
      "User-Agent": ua,
    }),
    HttpClientRequest.bodyText(body, "application/json")
  );
}

// ---- the plugin ------------------------------------------------------------------------

// a request that never leaves the process: what http.request sends instead
// when it can't reach Kiro, so http.response can say why
const standIn = () => new Request("data:application/json,%7B%7D", { method: "POST", body: "{}" });

// what http.response needs to turn a call's answer back, by the call: the
// turn, and the sign-in it was sent with, so a token Kiro turns down is
// refreshed once; or why it couldn't be sent
type Sent = { turn: Conversation.Turn; a: Auth; error?: never } | { error: Failure.Failure };

// Host is the part of OpenCode's plugin context this plugin uses.
type Host = Usage.Host & {
  readonly provider: Pick<Plugin.Context["provider"], "transform" | "reload">;
  readonly session: Pick<Plugin.Context["session"], "hook">;
};

const make = Effect.fn("Kiro.make")(function* (ctx: Host) {
  const account = yield* KiroAccount;
  const images = yield* Images;
  const http = yield* HttpClient.HttpClient;
  // each request sent to Kiro → what turning its answer back needs
  const sent = new WeakMap<Request, Sent>();
  // the account's models: last run's until Kiro lists them
  const models = yield* Ref.make(
    Option.getOrElse(decodeSaved(yield* ctx.storage.get(MODELS_KEY)), () => FALLBACK)
  );
  // what each reply cost, for the sidebar
  const usage = yield* Usage.make(ctx);

  // the call that sends a turn to Kiro, its images fitted
  const callFor = (turn: Conversation.Turn, a: Auth) =>
    images.fit(turn.request(a.profile)).pipe(Effect.map((b) => kiroCall(a, JSON.stringify(b))));

  // the provider is added again on each reload, with the models then known
  yield* ctx.provider.transform((editor) => {
    editor.add({ info: PROVIDER, models: Ref.getUnsafe(models).map(modelInfo) });
  });

  yield* ctx.session.hook(
    "http.request",
    Effect.fn("Kiro.request")(
      function* (event) {
        if (!new URL(event.request.url).pathname.endsWith("/messages")) return;
        // OpenCode's own Anthropic route wrote this body (see Conversation.MessagesRequest)
        const req = (yield* Effect.tryPromise(() =>
          event.request.clone().json()
        )) as Conversation.MessagesRequest;
        const turn = Conversation.open(req, yield* Ref.get(models));
        const a = yield* account.credentials();
        const call = yield* HttpClientRequest.toWeb(yield* callFor(turn, a));
        sent.set(call, { turn, a });
        event.request = call;
      },
      // a hook that fails fails the request with no message, so a failure
      // here goes on to http.response as a stand-in that answers with it
      (effect, event) =>
        Effect.catchCause(effect, (cause) =>
          Effect.sync(() => {
            const call = standIn();
            sent.set(call, { error: Failure.fromCause(cause) });
            event.request = call;
          })
        )
    ),
    { providerID: ID }
  );

  yield* ctx.session.hook(
    "http.response",
    Effect.fn("Kiro.response")(
      function* (event) {
        const p = sent.get(event.request);
        if (!p) return;
        sent.delete(event.request);
        if (p.error) {
          event.response = Failure.toResponse(p.error);
          return;
        }
        let res = HttpClientResponse.fromWeb(
          HttpClientRequest.fromWeb(event.request),
          event.response
        );
        // a token Kiro turned down: once more, refreshed, unless kiro-cli
        // already has
        if (res.status === 401 || res.status === 403) {
          const turnedDown = event.response;
          yield* Effect.tryPromise(() => turnedDown.body?.cancel() ?? Promise.resolve()).pipe(
            Effect.ignore
          );
          const a = yield* account.credentials(p.a.token);
          res = yield* send(yield* callFor(p.turn, a), HEADERS_SECONDS);
        }
        if (res.status < 200 || res.status > 299) {
          const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          event.response = Failure.toResponse(
            Failure.fromReply(res.status, body.slice(0, 1 << 20), res.headers)
          );
          return;
        }
        event.response = yield* p.turn.answer(res.stream, (u) => usage.record(event.sessionID, u));
      },
      (effect, event) =>
        effect.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              event.response = cause.pipe(Failure.fromCause, Failure.toResponse);
            })
          )
        )
    ),
    { providerID: ID }
  );

  // the account's own models once Kiro lists them. A listing that fails on
  // the network or on Kiro's side is tried again 5, 20 and 80 seconds later.
  yield* Effect.gen(function* () {
    const listed = yield* account.models;
    if (JSON.stringify(listed) === JSON.stringify(yield* Ref.get(models))) return;
    yield* Ref.set(models, listed);
    yield* ctx.storage.set(MODELS_KEY, listed);
    yield* ctx.provider.reload();
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("5 seconds", 4),
      times: 3,
      while: (e) =>
        Schema.is(Failure.RefreshError)(e) ||
        (Schema.is(Failure.KiroApiError)(e) && (e.status === 429 || e.status >= 500)),
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro: listing the account's models failed", cause)
    ),
    Effect.forkScoped
  );
});

// the services make runs on: the account and image fitting, over fetch
const layer = Layer.mergeAll(KiroAccount.layer, Images.layer).pipe(
  Layer.provideMerge(FetchHttpClient.layer)
);

export default {
  id: ID,
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the plugin's entry point
  effect: (ctx) => make(ctx).pipe(Effect.provide(layer)),
} satisfies Plugin.Plugin;

// for tests
export const _internal = { make };
