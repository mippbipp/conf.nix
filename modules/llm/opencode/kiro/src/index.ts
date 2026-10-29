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
import { Array as Arr, Effect, Layer, Option, Ref, Schedule, Schema, String as Str } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type Auth, authHeaders, KiroAccount } from "./account.ts";
import * as Conversation from "./conversation.ts";
import * as Failure from "./failure.ts";
import { Images } from "./images.ts";
import { HEADERS_SECONDS, ID, IDLE_SECONDS, isOk, send } from "./kiro.ts";
import { decodeSaved, FALLBACK, modelInfo, sameModels } from "./models.ts";
import * as Usage from "./usage.ts";

const PACKAGE = "@opencode/ai/providers/anthropic";
// where the Anthropic route posts; http.request sends it on to the account's region
const BASE = "https://runtime.us-east-1.kiro.dev";
const MODELS_KEY = "models";

const runtime = (region: string) => `https://runtime.${region}.kiro.dev`;

// ---- models ----------------------------------------------------------------------

const PROVIDER: Provider.Info = {
  // SAFETY: OpenCode brands provider IDs; this plugin's is ID
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
function kiroCall(auth: Auth, body: string) {
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${Str.replaceAll("-", "")(randomUUID())}`;
  return HttpClientRequest.post(`${runtime(auth.region)}/generateAssistantResponse`).pipe(
    HttpClientRequest.setHeaders({
      ...authHeaders(auth),
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
type Sent = { turn: Conversation.Turn; auth: Auth; error?: never } | { error: Failure.Failure };

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

  // the account's own models once Kiro lists them. A listing that fails on
  // the network or on Kiro's side is tried again 5, 20 and 80 seconds later.
  // One that still fails on an error that can pass (no sign-in yet, the
  // network, a 429 or 5xx from Kiro) sets listAgain, and the next request
  // that finds a sign-in lists again. So a kiro-cli login or the end of an
  // outage after OpenCode started is picked up. The request clears
  // listAgain before it starts the listing, so only one runs at a time, and
  // each failed listing leads to one more try at most.
  const listAgain = yield* Ref.make(false);
  const mayPass = (error: Effect.Error<typeof account.models>) =>
    Schema.is(Failure.RefreshError)(error) ||
    (Schema.is(Failure.KiroApiError)(error) && (error.status === 429 || error.status >= 500));
  const listModels = Effect.gen(function* () {
    const found = yield* account.models;
    if (sameModels(found, yield* Ref.get(models))) return;
    yield* Ref.set(models, found);
    yield* ctx.storage.set(MODELS_KEY, found);
    yield* ctx.provider.reload();
  }).pipe(
    Effect.retry({ schedule: Schedule.exponential("5 seconds", 4), times: 3, while: mayPass }),
    Effect.tapError((error) =>
      Schema.is(Failure.SignInError)(error) || mayPass(error)
        ? Ref.set(listAgain, true)
        : Effect.void
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro: listing the account's models failed", cause)
    )
  );
  const scope = yield* Effect.scope;
  const listIfAsked = Effect.gen(function* () {
    if (yield* Ref.getAndSet(listAgain, false)) yield* Effect.forkIn(listModels, scope);
  });

  // the call that sends a turn to Kiro, its images fitted
  const callFor = (turn: Conversation.Turn, auth: Auth) =>
    images
      .fit(turn.request(auth.profile))
      .pipe(Effect.map((request) => kiroCall(auth, JSON.stringify(request))));

  // the provider is added again on each reload, with the models then known
  yield* ctx.provider.transform((editor) => {
    editor.add({ info: PROVIDER, models: Arr.map(Ref.getUnsafe(models), modelInfo) });
  });

  yield* ctx.session.hook(
    "http.request",
    Effect.fn("Kiro.request")(
      function* (event) {
        if (!Str.endsWith("/messages")(new URL(event.request.url).pathname)) return;
        // SAFETY: OpenCode's own Anthropic route wrote this body, and
        // Conversation reads each field as if it might be missing
        const req = (yield* Effect.tryPromise(() =>
          event.request.clone().json()
        )) as Conversation.MessagesRequest;
        const turn = Conversation.open(req, yield* Ref.get(models));
        const auth = yield* account.credentials();
        yield* listIfAsked;
        const call = yield* HttpClientRequest.toWeb(yield* callFor(turn, auth));
        sent.set(call, { turn, auth });
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
        const call = sent.get(event.request);
        if (!call) return;
        sent.delete(event.request);
        if (call.error) {
          event.response = Failure.toResponse(call.error);
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
          const auth = yield* account.credentials(call.auth.token);
          res = yield* send(yield* callFor(call.turn, auth), HEADERS_SECONDS);
        }
        if (!isOk(res.status)) {
          const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          event.response = Failure.toResponse(
            Failure.fromReply(res.status, Str.slice(0, 1 << 20)(body), res.headers)
          );
          return;
        }
        event.response = yield* call.turn.answer(res.stream, (spent) =>
          usage.record(event.sessionID, spent)
        );
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

  yield* Effect.forkScoped(listModels);
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
