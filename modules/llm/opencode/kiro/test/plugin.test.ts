// The plugin through its hooks, as OpenCode runs it: make on a fake host.
// HOME is a throwaway dir so no real sign-in is read or written, and PATH is
// empty so kiro-cli is never run. The plugin reads both on each call. Its
// HTTP goes to the fake network (see network.ts), never the network.

import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Effect,
  Layer,
  Option,
  Schema,
  type Scope,
  String as Str,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import type { KiroRequest, MessagesRequest } from "../src/conversation.ts";
import { Images } from "../src/images.ts";
import { internal as plugin } from "../src/index.ts";
import { assertCloseTo, assertStartsWith, assertSubset } from "./assert.ts";
import { errorOf, frame, sse } from "./eventstream.ts";
import { toJson } from "./json.ts";
import { codex, imagesOf, LIMIT, REPORTED } from "./messages.ts";
import { fakeNetwork, offline, pathOf, reply, unanswered } from "./network.ts";
import { throwawayHome } from "./signin.ts";

const { signIn, signOut } = throwawayHome();

const net = fakeNetwork();
const layer = Layer.mergeAll(KiroAccount.layer, Images.layer).pipe(
  Layer.provideMerge(net.layer)
);
type Services = Layer.Success<typeof layer>;
// run runs effect in a scope of its own, on the plugin's services, the
// network offline after
const run = <A, E>(effect: Effect.Effect<A, E, Services | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(layer), net.reset);

// Kiro answering with these AWS event stream messages
const stream = (...frames: Array<Uint8Array>) =>
  new Response(new Blob(frames), { status: 200 });

// the parts of a session hook's event the plugin reads
interface HookEvent {
  request: Request;
  response?: Response;
  sessionID?: string;
}
type Hook = (event: HookEvent) => Effect.Effect<void>;
// the part of OpenCode's plugin context the plugin uses
type Host = Parameters<typeof plugin.make>[0];

// a fake OpenCode plugin context, recording what the plugin registers; its
// storage holds the model list an earlier run saved
const SAVED = [
  {
    context: 1000,
    efforts: ["low"],
    fields: "claude",
    id: "claude-x",
    images: true,
    name: "claude-x",
    output: 100,
  },
];
interface Added {
  readonly info: { readonly id: string };
  readonly models: ReadonlyArray<{ readonly id: string }>;
}
// the usage RPC's handler as the plugin registers it
type UsageHandler = (
  input: { sessionIDs: Array<string> },
  context: unknown
) => Effect.Effect<{
  account: Schema.Json;
  credits: Record<string, number>;
}>;

function fakeHost() {
  const hooks = new Map<string, { fn: Hook; options: unknown }>();
  const added: Array<Added> = [];
  const saved: Array<unknown> = [];
  const store = new Map<string, Schema.Json>([["models", SAVED]]);
  const registered = { dispose: Effect.void };
  // the RPC's usage handler, and the events it emitted
  const usageHandlers: Array<UsageHandler> = [];
  const emitted: Array<string> = [];
  // how many times the plugin had the provider reloaded
  const fake = { reloads: 0 };
  const ctx: Host = {
    provider: {
      reload: () =>
        Effect.sync(() => {
          fake.reloads += 1;
        }),
      transform: (fn) =>
        Effect.sync(() => {
          // SAFETY: the plugin's transform calls add alone
          fn({
            add: (entry) => {
              added.push(entry);
            },
          } as Parameters<typeof fn>[0]);
          return registered;
        }),
    },
    rpc: {
      register: (_definition, handlers) =>
        Effect.sync(() => {
          // SAFETY: the plugin registers only KiroRpc, whose one method is usage
          usageHandlers.push(
            (handlers as { readonly usage: UsageHandler }).usage
          );
          return {
            ...registered,
            events: {
              emit: (...[name]) => Effect.sync(() => void emitted.push(name)),
            },
          };
        }),
    },
    session: {
      hook: (name, fn, options) =>
        Effect.sync(() => {
          // SAFETY: the plugin's hooks read and set only HookEvent's fields
          hooks.set(name, { fn: fn as Hook, options });
          return registered;
        }),
    },
    storage: {
      get: (key) => Effect.sync(() => store.get(key)),
      set: (key, value) =>
        Effect.sync(() => {
          if (key === "models") {
            saved.push(value);
          }
          store.set(key, value);
        }),
    },
  };
  // hook is the hook the plugin registered under name
  const hook = (name: string) => {
    const found = hooks.get(name);
    if (found === undefined) {
      throw new Error(`no ${name} hook was registered`);
    }
    return found;
  };
  // usageOfRpc is what the usage RPC answers for sessionIDs
  const usageOfRpc = (sessionIDs: Array<string> = []) =>
    Effect.fromOption(Arr.last(usageHandlers)).pipe(
      Effect.orDie,
      Effect.flatMap((handler) => handler({ sessionIDs }, {}))
    );
  return Object.assign(fake, {
    added,
    ctx,
    emitted,
    hook,
    saved,
    store,
    usageOfRpc,
  });
}
type FakeHost = ReturnType<typeof fakeHost>;

// load makes the plugin on a fake host in a scope of its own, which closes
// once make returns: the hooks stay registered, and the model listing make
// starts is stopped
const load = () => {
  const host = fakeHost();
  return run(plugin.make(host.ctx)).pipe(Effect.as(host));
};
const messages = (body: MessagesRequest) =>
  new Request("https://runtime.us-east-1.kiro.dev/messages", {
    body: toJson(body),
    headers: { "content-type": "application/json", "x-api-key": "unused" },
    method: "POST",
  });
const HI: MessagesRequest = {
  messages: [{ content: "hi", role: "user" }],
  model: "claude-x",
};
// respond hands response to the http.response hook for event's request,
// and is the response it leaves
const respond = Effect.fnUntraced(function* (
  host: FakeHost,
  event: HookEvent,
  response: Response
) {
  const res: HookEvent = {
    request: event.request,
    response,
    sessionID: event.sessionID,
  };
  yield* host.hook("http.response").fn(res);
  return yield* Effect.fromOption(Option.fromUndefinedOr(res.response)).pipe(
    Effect.orDie
  );
});
// ask sends a Messages request through both hooks, Kiro answering with response
const ask = Effect.fnUntraced(function* (
  host: FakeHost,
  response: Response,
  { body = HI, sessionID }: { body?: MessagesRequest; sessionID?: string } = {}
) {
  const event: HookEvent = { request: messages(body), sessionID };
  yield* host.hook("http.request").fn(event);
  return yield* respond(host, event, response);
});
// fetched is what OpenCode's HTTP client, fetch, gets for a request
const fetched = (request: Request) =>
  HttpClient.execute(HttpClientRequest.fromWeb(request)).pipe(
    Effect.flatMap((res) => Effect.fromOption(HttpClientResponse.toWeb(res))),
    Effect.orDie,
    Effect.provide(FetchHttpClient.layer)
  );
const KiroBody = Schema.fromJsonString(Schema.Unknown);
// sentBody is the Kiro request the plugin built
const sentBody = (request: Request) =>
  Effect.promise(() => request.clone().text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(KiroBody)),
    Effect.orDie,
    // SAFETY: http.request sent on the Kiro request the plugin built
    Effect.map((body) => body as KiroRequest)
  );
const contentDelta = (res: Response) =>
  sse(res).pipe(
    Effect.map((events) =>
      Option.getOrThrow(
        Arr.findFirst(events, (event) => event.type === "content_block_delta")
      )
    )
  );
// a stand-in for a model listing Kiro answers with claude-y
const CLAUDE_Y = { models: [{ modelId: "claude-y", modelName: "Claude Y" }] };
// savedIsClaudeY checks that the plugin saved one listing, of claude-y
const savedIsClaudeY = (saved: Array<unknown>) => {
  assert.lengthOf(saved, 1);
  const [listing] = saved;
  assert.isTrue(Arr.isArray(listing));
  const models: ReadonlyArray<unknown> = Arr.isArray(listing) ? listing : [];
  assert.lengthOf(models, 1);
  assertSubset(models[0], { id: "claude-y", name: "Claude Y" });
};

describe("hooks", () => {
  it.live(
    "hooks: Kiro is sent the fitted image",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const event: HookEvent = { request: messages(codex(REPORTED, true)) };
        yield* host.hook("http.request").fn(event);
        assert.strictEqual(
          event.request.url,
          "https://runtime.us-east-1.kiro.dev/generateAssistantResponse"
        );
        const body = yield* sentBody(event.request);
        const sentImages = imagesOf(body.conversationState);
        assert.lengthOf(sentImages, 1);
        assert.isAtMost(sentImages[0]?.source.bytes.length ?? Infinity, LIMIT);
      }).pipe(net.reset),
    60_000
  );

  it.live(
    "hooks: a Messages request goes to Kiro, and its event stream comes back as Messages events",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        assert.deepStrictEqual(host.hook("http.request").options, {
          providerID: "kiro",
        });
        const [provider] = host.added;
        assert.isDefined(provider);
        assertSubset(provider.info, {
          activation: "enabled",
          id: "kiro",
          package: "@opencode/ai/providers/anthropic",
        });
        assert.deepStrictEqual(
          Arr.map(provider.models, (model) => model.id),
          ["claude-x"]
        );

        const longTool =
          "mcp__a_very_long_server_name__and_an_even_longer_tool_name_for_this";
        const event: HookEvent = {
          request: messages({
            max_tokens: 1000,
            messages: [
              { content: [{ text: "weather?", type: "text" }], role: "user" },
            ],
            model: "claude-x",
            stream: true,
            tools: [{ input_schema: { type: "object" }, name: longTool }],
          }),
        };
        yield* host.hook("http.request").fn(event);
        assert.strictEqual(
          event.request.url,
          "https://runtime.us-east-1.kiro.dev/generateAssistantResponse"
        );
        assert.strictEqual(
          event.request.headers.get("authorization"),
          "Bearer tok"
        );
        assert.strictEqual(
          event.request.headers.get("content-type"),
          "application/json"
        );
        assert.isNull(event.request.headers.get("traceparent"));
        const body = yield* sentBody(event.request);
        const current = body.conversationState.currentMessage.userInputMessage;
        assertSubset(current, { content: "weather?", modelId: "claude-x" });
        const kiroTool =
          current.userInputMessageContext?.tools?.[0]?.toolSpecification
            ?.name ?? "";
        assert.isAtMost(kiroTool.length, 64);

        const res = yield* respond(
          host,
          event,
          stream(
            frame("reasoningContentEvent", { text: "hmm" }),
            frame("assistantResponseEvent", { content: "Let me look." }),
            frame("toolUseEvent", { name: kiroTool, toolUseId: "t1" }),
            frame("toolUseEvent", {
              input: '{"city":',
              name: kiroTool,
              toolUseId: "t1",
            }),
            frame("toolUseEvent", {
              input: '"Paris"}',
              name: kiroTool,
              toolUseId: "t1",
            }),
            frame("contextUsageEvent", { contextUsagePercentage: 10 }),
            frame("metadataEvent", { stopReason: "TOOL_USE" })
          )
        );
        const out = yield* sse(res);
        assert.deepStrictEqual(
          Arr.map(out, (streamed) => streamed.type),
          [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
          ]
        );
        assert.strictEqual(out[1]?.content_block?.type, "thinking");
        assertSubset(out[7]?.content_block, {
          name: longTool,
          type: "tool_use",
        });
        assertSubset(out[11], {
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 100 },
        });
      }).pipe(net.reset)
  );

  it.live.each([401, 403])(
    "hooks: a token Kiro turns down (%i) is refreshed and the request sent once more",
    (status) =>
      Effect.gen(function* () {
        signIn({ access: "stale" });
        const host = yield* load();
        const sent: Array<string | undefined> = [];
        net.answer = (request) => {
          if (Str.includes("oidc")(request.url)) {
            return reply({
              accessToken: "fresh",
              expiresIn: 3600,
              refreshToken: "r2",
            });
          }
          sent.push(request.headers.authorization);
          return Effect.succeed(
            stream(
              frame("assistantResponseEvent", { content: "ok" }),
              frame("metadataEvent", { stopReason: "END_TURN" })
            )
          );
        };
        const res = yield* ask(host, new Response("{}", { status }));
        net.answer = offline;
        assert.deepStrictEqual(sent, ["Bearer fresh"]);
        const delta = yield* contentDelta(res);
        assert.strictEqual(delta.delta?.text, "ok");
      }).pipe(net.reset)
  );

  it.live(
    "hooks: an error Kiro answers with, or an exception before the answer, is a status",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const answered = Effect.fnUntraced(function* (response: Response) {
          const res = yield* ask(host, response);
          const error = yield* errorOf(res);
          return { error, headers: res.headers, status: res.status };
        });
        // a 429 keeps Kiro's Retry-After, which OpenCode waits for
        const throttled = yield* answered(
          Response.json(
            { message: "Too many requests" },
            {
              headers: {
                "retry-after": "7",
                "x-amzn-errortype":
                  "ThrottlingException:http://internal.amazon.com/coral/",
              },
              status: 429,
            }
          )
        );
        assert.strictEqual(throttled.status, 429);
        assert.strictEqual(throttled.headers.get("retry-after"), "7");
        assert.deepStrictEqual(throttled.error, {
          message:
            "Kiro is rate limiting requests. Kiro said: Too many requests",
          type: "rate_limit_error",
        });
        // an exception before any of the answer is a status too
        const streamed = yield* answered(
          stream(
            frame("ThrottlingException", { message: "slow down" }, "exception")
          )
        );
        assert.strictEqual(streamed.status, 429);
        assert.strictEqual(
          streamed.error.message,
          "Kiro is rate limiting requests. Kiro said: slow down"
        );
      }).pipe(net.reset)
  );

  it.live(
    "hooks: a request the plugin can't handle says so, and isn't retried",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const event: HookEvent = {
          request: new Request("https://runtime.us-east-1.kiro.dev/messages", {
            body: "not json",
            method: "POST",
          }),
        };
        yield* host.hook("http.request").fn(event);
        const standIn = yield* fetched(event.request);
        const res = yield* respond(host, event, standIn);
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.headers.get("x-should-retry"), "false");
        const error = yield* errorOf(res);
        assertStartsWith(
          error.message,
          "The Kiro plugin failed on this request"
        );
      }).pipe(net.reset)
  );

  it.live(
    "hooks: a reply that breaks off after it began ends in an error event",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const broken = new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(frame("assistantResponseEvent", { content: "Half" }));
            // the next message's header, and no more of it
            const next = frame("assistantResponseEvent", {
              content: " an answer",
            });
            ctl.enqueue(next.subarray(0, 20));
            ctl.close();
          },
        });
        const res = yield* ask(host, new Response(broken, { status: 200 }));
        assert.strictEqual(res.status, 200);
        const out = yield* sse(res);
        assert.deepStrictEqual(
          Arr.map(out, (event) => event.type),
          [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "error",
          ]
        );
        assert.deepStrictEqual(out[4]?.error, {
          message:
            "Kiro's reply broke off before it finished: the connection closed partway through an event",
          type: "api_error",
        });
      }).pipe(net.reset)
  );
});

// the fake network answers on the event loop, so each step gives it a
// moment of real time
const settle = TestClock.withLive(Effect.sleep("20 millis"));
// what a request starts runs beside it, on the live clock
const settleLive = Effect.sleep("30 millis");

describe("models", () => {
  it.effect(
    "models: a listing Kiro fails is tried again, 5 and then 20 seconds later",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = fakeHost();
        let calls = 0;
        net.answer = () => {
          calls += 1;
          if (calls < 3) {
            return reply({ message: "busy" }, { status: 500 });
          }
          return reply(CLAUDE_Y);
        };
        yield* run(
          Effect.gen(function* () {
            yield* plugin.make(host.ctx);
            yield* settle;
            assert.strictEqual(calls, 1);
            yield* TestClock.adjust("4 seconds");
            yield* settle;
            assert.strictEqual(calls, 1);
            yield* TestClock.adjust("1 second");
            yield* settle;
            assert.strictEqual(calls, 2);
            yield* TestClock.adjust("20 seconds");
            yield* settle;
            assert.strictEqual(calls, 3);
          })
        );
        savedIsClaudeY(host.saved);
      })
  );

  it.live(
    "models: a listing that found no sign-in is made again once a request finds one",
    () =>
      Effect.gen(function* () {
        signOut();
        const host = fakeHost();
        const listings: Array<string> = [];
        net.answer = (request) => {
          listings.push(pathOf(request));
          return reply(CLAUDE_Y);
        };
        yield* run(
          Effect.gen(function* () {
            yield* plugin.make(host.ctx);
            yield* settleLive;
            assert.deepStrictEqual(listings, []);
            // kiro-cli login, then the next request
            signIn({ access: "tok" });
            yield* host.hook("http.request").fn({ request: messages(HI) });
            yield* settleLive;
          })
        );
        assert.deepStrictEqual(listings, ["/List-Available-Models"]);
        savedIsClaudeY(host.saved);
        assert.strictEqual(host.reloads, 1);
      })
  );

  it.effect(
    "models: a listing that gave up on Kiro's errors is made again by the next request",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = fakeHost();
        let calls = 0;
        let busy = true;
        net.answer = () => {
          calls += 1;
          if (busy) {
            return reply({ message: "busy" }, { status: 503 });
          }
          return reply(CLAUDE_Y);
        };
        yield* run(
          Effect.gen(function* () {
            yield* plugin.make(host.ctx);
            yield* settle;
            for (const seconds of [5, 20, 80]) {
              yield* TestClock.adjust(`${seconds} seconds`);
              yield* settle;
            }
            assert.strictEqual(calls, 4);
            yield* TestClock.adjust("10 minutes");
            yield* settle;
            assert.strictEqual(calls, 4);
            assert.deepStrictEqual(host.saved, []);
            busy = false;
            yield* host.hook("http.request").fn({ request: messages(HI) });
            yield* settle;
          })
        );
        assert.strictEqual(calls, 5);
        savedIsClaudeY(host.saved);
        assert.strictEqual(host.reloads, 1);
      })
  );

  it.live(
    "models: a listing Kiro refused (403) isn't made again by a request",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = fakeHost();
        let calls = 0;
        net.answer = () => {
          calls += 1;
          return reply({ message: "not allowed" }, { status: 403 });
        };
        yield* run(
          Effect.gen(function* () {
            yield* plugin.make(host.ctx);
            yield* settleLive;
            yield* host.hook("http.request").fn({ request: messages(HI) });
            yield* settleLive;
          })
        );
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(host.saved, []);
      })
  );
});

// Kiro caches but says nothing of it: a real reply (2026-10-24) ends with
// these events and no tokenUsage, so no input, output or cache counts at all.
// Saying cache_read_input_tokens 0 would read as a cache that never hits.
const usageOf = (res: Response) =>
  sse(res).pipe(
    Effect.map(
      (events) =>
        Option.getOrThrow(
          Arr.findFirst(events, (event) => event.type === "message_delta")
        ).usage
    )
  );

describe("replies", () => {
  it.live(
    "hooks: with no sign-in, the request answers with why instead of reaching Kiro",
    () =>
      Effect.gen(function* () {
        signOut();
        const host = yield* load();
        const event: HookEvent = { request: messages(HI) };
        yield* host.hook("http.request").fn(event);
        assertStartsWith(event.request.url, "data:");
        // what OpenCode's HTTP client gets for the stand-in, which never leaves the process
        const standIn = yield* fetched(event.request);
        const res = yield* respond(host, event, standIn);
        assert.strictEqual(res.status, 401);
        const error = yield* errorOf(res);
        assert.include(error.message, "kiro-cli login");
      }).pipe(net.reset)
  );

  it.live(
    "hooks: a reply with no token counts leaves the cache out, and reckons the input",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const res = yield* ask(
          host,
          stream(
            frame("assistantResponseEvent", { content: "OK" }),
            frame("metadataEvent", { stopReason: "END_TURN" }),
            frame("contextUsageEvent", {
              contextUsagePercentage: 11.032500267028809,
            }),
            frame("meteringEvent", {
              unit: "credit",
              unitPlural: "credits",
              usage: 0.091,
            })
          )
        );
        // claude-x's window is 1000 tokens; "OK" is about 1 token
        const usage = yield* usageOf(res);
        assert.deepStrictEqual(usage, { input_tokens: 110, output_tokens: 1 });
      }).pipe(net.reset)
  );

  it.live(
    "hooks: a reply whose metadataEvent counts tokens tells them, cache included",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const tokenUsage = {
          cacheReadInputTokens: 9000,
          cacheWriteInputTokens: 0,
          outputTokens: 3,
          totalTokens: 9123,
          uncachedInputTokens: 120,
        };
        const res = yield* ask(
          host,
          stream(
            frame("assistantResponseEvent", { content: "OK" }),
            frame("metadataEvent", { stopReason: "END_TURN", tokenUsage })
          )
        );
        const usage = yield* usageOf(res);
        assert.deepStrictEqual(usage, {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 9000,
          input_tokens: 120,
          output_tokens: 3,
        });
      }).pipe(net.reset)
  );

  it.live(
    "hooks: an exception after the answer began ends the stream with an error event",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const host = yield* load();
        const res = yield* ask(
          host,
          stream(
            frame("assistantResponseEvent", { content: "Hello" }),
            frame("ThrottlingException", { message: "slow down" }, "exception")
          )
        );
        assert.strictEqual(res.status, 200);
        const out = yield* sse(res);
        assert.deepStrictEqual(
          Arr.map(out, (event) => event.type),
          [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "error",
          ]
        );
        assert.strictEqual(out[2]?.delta?.text, "Hello");
        assert.strictEqual(out[4]?.error?.type, "rate_limit_error");
      }).pipe(net.reset)
  );

  it.live(
    "hooks: a refresh failing after Kiro turned the token down is a status, not a stream",
    () =>
      Effect.gen(function* () {
        signIn({ access: "stale" });
        const host = yield* load();
        net.answer = () => Effect.succeed(new Response("", { status: 503 }));
        const retried = yield* ask(host, new Response("{}", { status: 403 }));
        assert.strictEqual(retried.status, 502);
        const retriedError = yield* errorOf(retried);
        assertStartsWith(
          retriedError.message,
          "Couldn't refresh Kiro's sign-in"
        );
        net.answer = (request) =>
          request.url === "https://oidc.us-east-1.amazonaws.com/token"
            ? reply({}, { status: 400 })
            : Effect.succeed(new Response("", { status: 500 }));
        const refused = yield* ask(host, new Response("{}", { status: 403 }));
        assert.strictEqual(refused.status, 401);
        const refusedError = yield* errorOf(refused);
        assert.include(refusedError.message, "kiro-cli login");
      }).pipe(net.reset)
  );
});

// ---- usage: the sidebar's credits, end to end (the rest is in usage.test.ts) -----

// Get-Usage-Limits as Kiro answered it (2026-10-28) for a Kiro Pro account
// over its limit, the user's own details made up
const PRO_USAGE = {
  daysUntilReset: null,
  limits: null,
  nextDateReset: 1_793_491_200,
  overageConfiguration: { overageStatus: "ENABLED" },
  subscriptionInfo: {
    overageCapability: "OVERAGE_CAPABLE",
    subscriptionManagementTarget: "MANAGE",
    subscriptionTitle: "KIRO PRO",
    type: "Q_DEVELOPER_STANDALONE_PRO",
    upgradeCapability: "UPGRADE_INCAPABLE",
  },
  usageBreakdownList: [
    {
      bonuses: [],
      currency: "USD",
      currentOverages: 7978,
      currentOveragesWithPrecision: 7978.62,
      currentUsage: 8978,
      currentUsageWithPrecision: 8978.62,
      displayName: "Credit",
      displayNamePlural: "Credits",
      freeTrialInfo: null,
      nextDateReset: 1_793_491_200,
      overageCap: 40_000,
      overageCapWithPrecision: 40_000,
      overageCharges: 319.144848378096,
      overageCredits: [],
      overageRate: 0.04,
      resourceType: "CREDIT",
      unit: "INVOCATIONS",
      usageLimit: 1000,
      usageLimitWithPrecision: 1000,
    },
  ],
  userInfo: { email: "someone@example.com", userId: "user-1" },
};

// answerUsage has Kiro's management API answer usage
const answerUsage = (usage: Schema.JsonObject) => {
  net.answer = (request) => {
    const path = pathOf(request);
    if (!Str.endsWith("/Get-Usage-Limits")(path)) {
      return unanswered(`unexpected ${path}`);
    }
    return reply(usage);
  };
};
// a reply through both hooks, its body read to the end
const replyIn = Effect.fnUntraced(function* (
  host: FakeHost,
  sessionID: string,
  ...frames: Array<Uint8Array>
) {
  const res = yield* ask(host, stream(...frames), { sessionID });
  yield* sse(res);
  // what a finished reply starts runs beside it
  yield* Effect.sleep("30 millis");
});
const metering = (usage: number) =>
  frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage });

describe("usage", () => {
  it.live(
    "usage: a reply's meteringEvents add up, and a session's replies add up in storage",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        answerUsage(PRO_USAGE);
        // the plugin loaded in a scope that stays open, as OpenCode keeps it
        const host = fakeHost();
        yield* plugin.make(host.ctx);
        yield* replyIn(
          host,
          "ses_a",
          frame("assistantResponseEvent", { content: "OK" }),
          metering(0.091)
        );
        assertCloseTo(host.store.get("credits/ses_a"), 0.091);
        yield* replyIn(
          host,
          "ses_a",
          frame("assistantResponseEvent", { content: "OK" }),
          metering(0.2),
          metering(0.05)
        );
        const { account, credits } = yield* host.usageOfRpc(["ses_a", "ses_b"]);
        assertSubset(account, {
          plan: "Kiro Pro",
          resetsAt: 1_793_491_200_000,
        });
        assertCloseTo(host.store.get("credits/ses_a"), 0.341);
        assert.isFalse(host.store.has("credits/ses_b"));
        assertCloseTo(credits.ses_a, 0.341);
        assert.strictEqual(credits.ses_b, 0);
        // each finished reply tells the sidebar to look again
        assert.deepStrictEqual(host.emitted, ["updated", "updated"]);
      }).pipe(run)
  );
});
