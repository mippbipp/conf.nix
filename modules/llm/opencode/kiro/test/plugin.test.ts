// Run in the plugin directory (modules/llm/opencode/kiro), with BUN_BE_BUN=1
// so opencode acts as the Bun it ships, the runtime the plugin loads in:
//   BUN_BE_BUN=1 opencode test
//   BUN_BE_BUN=1 opencode install && BUN_BE_BUN=1 opencode run ox   # format, lint, tsc
// The plugin through its hooks, as OpenCode runs it: make on a fake host.
// HOME is a throwaway dir so no real sign-in is read or written, and PATH is
// empty so kiro-cli is never run. The plugin reads both on each call. Its
// HTTP goes to the fake client below, never the network.

import { expect, test } from "bun:test";

import { Effect, Layer, type Scope } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import type { KiroRequest } from "../src/conversation.ts";
import { Images } from "../src/images.ts";
import { _internal as k } from "../src/index.ts";
import { errorOf, frame, sse } from "./eventstream.ts";
import { codex, imagesOf, LIMIT, REPORTED } from "./messages.ts";
import { throwawayHome } from "./signin.ts";

const { signIn, signOut } = throwawayHome();

// the fake network: each test sets how it answers
type Answer = (request: HttpClientRequest.HttpClientRequest) => Promise<Response>;
const offline: Answer = async () => {
  throw new Error("no network in tests");
};
let answer = offline;
const http = HttpClient.make((request) =>
  Effect.tryPromise({
    try: async () => HttpClientResponse.fromWeb(request, await answer(request)),
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      }),
  })
);
const layer = Layer.mergeAll(KiroAccount.layer, Images.layer).pipe(
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http))
);
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) => {
  const result = Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)));
  return result.finally(() => {
    answer = offline;
  });
};

// Kiro answering with these AWS event stream messages
const stream = (...frames: Uint8Array[]) => new Response(new Blob(frames), { status: 200 });

// the parts of a session hook's event the plugin reads
type HookEvent = { request: Request; response?: Response; sessionID?: string };
type Hook = (event: HookEvent) => Effect.Effect<void>;

// a fake OpenCode plugin context, recording what the plugin registers; its
// storage holds the model list an earlier run saved
const SAVED = [
  {
    id: "claude-x",
    name: "claude-x",
    context: 1000,
    output: 100,
    images: true,
    fields: "claude",
    efforts: ["low"],
  },
];
function fakeHost() {
  const hooks: Record<string, { fn: Hook; options: unknown }> = {};
  const added: { info: { id: string }; models: { id: string }[] }[] = [];
  const saved: unknown[] = [];
  const store = new Map<string, unknown>([["models", SAVED]]);
  const registered = { dispose: Effect.void };
  // the RPC's handlers, by method, and the events it emitted
  const rpc: Record<string, (input: unknown, context: unknown) => Effect.Effect<any>> = {};
  const emitted: string[] = [];
  const ctx = {
    storage: {
      get: (key: string) => Effect.sync(() => store.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          if (key === "models") saved.push(value);
          store.set(key, value);
        }),
    },
    provider: {
      transform: (fn: (editor: { add: (d: (typeof added)[number]) => void }) => void) =>
        Effect.sync(() => {
          fn({
            add: (d) => {
              added.push(d);
            },
          });
          return registered;
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: (name: string, fn: Hook, options: unknown) =>
        Effect.sync(() => {
          hooks[name] = { fn, options };
          return registered;
        }),
    },
    rpc: {
      register: (_definition: unknown, handlers: typeof rpc) =>
        Effect.sync(() => {
          Object.assign(rpc, handlers);
          return {
            ...registered,
            events: { emit: (name: string) => Effect.sync(() => void emitted.push(name)) },
          };
        }),
    },
  };
  // the fake has only what the plugin calls
  return {
    ctx: ctx as unknown as Parameters<typeof k.make>[0],
    hooks,
    added,
    saved,
    store,
    rpc,
    emitted,
  };
}
async function load() {
  const { ctx, hooks, added } = fakeHost();
  await run(k.make(ctx));
  const hook = (name: string) => {
    const h = hooks[name]!;
    return { options: h.options, fn: (event: HookEvent) => Effect.runPromise(h.fn(event)) };
  };
  return { hook, added };
}
const messages = (body: object) =>
  new Request("https://runtime.us-east-1.kiro.dev/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "unused" },
    body: JSON.stringify(body),
  });
// ask sends a Messages request through both hooks, Kiro answering with response
async function ask(
  hook: Awaited<ReturnType<typeof load>>["hook"],
  response: Response,
  body: object = { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
  sessionID?: string
) {
  const event: HookEvent = { request: messages(body), sessionID };
  await hook("http.request").fn(event);
  const res: HookEvent = { request: event.request, response, sessionID };
  await hook("http.response").fn(res);
  return res.response!;
}

test("hooks: Kiro is sent the fitted image", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const event: HookEvent = { request: messages(codex(REPORTED, true)) };
  await hook("http.request").fn(event);
  expect(event.request.url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
  const body = (await event.request.json()) as KiroRequest;
  const sentImages = imagesOf(body.conversationState);
  expect(sentImages).toHaveLength(1);
  expect(sentImages[0]!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
}, 60_000);

test("hooks: a Messages request goes to Kiro, and its event stream comes back as Messages events", async () => {
  signIn({ access: "tok" });
  const { hook, added } = await load();
  expect(hook("http.request").options).toEqual({ providerID: "kiro" });
  expect(added[0]!.info).toMatchObject({
    id: "kiro",
    package: "@opencode/ai/providers/anthropic",
    activation: "enabled",
  });
  expect(added[0]!.models.map((m) => m.id)).toEqual(["claude-x"]);

  const longTool = "mcp__a_very_long_server_name__and_an_even_longer_tool_name_for_this";
  const event: HookEvent = {
    request: messages({
      model: "claude-x",
      max_tokens: 1000,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
      tools: [{ name: longTool, input_schema: { type: "object" } }],
    }),
  };
  await hook("http.request").fn(event);
  expect(event.request.url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
  expect(event.request.headers.get("authorization")).toBe("Bearer tok");
  expect(event.request.headers.get("content-type")).toBe("application/json");
  expect(event.request.headers.get("traceparent")).toBeNull();
  const body = (await event.request.clone().json()) as KiroRequest;
  const current = body.conversationState.currentMessage.userInputMessage;
  expect(current).toMatchObject({ content: "weather?", modelId: "claude-x" });
  const kiroTool = current.userInputMessageContext?.tools?.[0]?.toolSpecification?.name ?? "";
  expect(kiroTool.length).toBeLessThanOrEqual(64);

  const res: HookEvent = {
    request: event.request,
    response: stream(
      frame("reasoningContentEvent", { text: "hmm" }),
      frame("assistantResponseEvent", { content: "Let me look." }),
      frame("toolUseEvent", { toolUseId: "t1", name: kiroTool }),
      frame("toolUseEvent", { toolUseId: "t1", name: kiroTool, input: '{"city":' }),
      frame("toolUseEvent", { toolUseId: "t1", name: kiroTool, input: '"Paris"}' }),
      frame("contextUsageEvent", { contextUsagePercentage: 10 }),
      frame("metadataEvent", { stopReason: "TOOL_USE" })
    ),
  };
  await hook("http.response").fn(res);
  const out = await sse(res.response!);
  expect(out.map((e) => e.type)).toEqual([
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
  ]);
  expect(out[1].content_block.type).toBe("thinking");
  expect(out[7].content_block).toMatchObject({ type: "tool_use", name: longTool });
  expect(out[11]).toMatchObject({
    delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 100 },
  });
});

test.each([401, 403])(
  "hooks: a token Kiro turns down (%i) is refreshed and the request sent once more",
  async (status) => {
    signIn({ access: "stale" });
    const { hook } = await load();
    const sent: (string | undefined)[] = [];
    answer = async (request) => {
      if (request.url.includes("oidc"))
        return Response.json({ accessToken: "fresh", refreshToken: "r2", expiresIn: 3600 });
      sent.push(request.headers.authorization);
      return stream(
        frame("assistantResponseEvent", { content: "ok" }),
        frame("metadataEvent", { stopReason: "END_TURN" })
      );
    };
    const res = await ask(hook, new Response("{}", { status }));
    answer = offline;
    expect(sent).toEqual(["Bearer fresh"]);
    const delta = (await sse(res)).find((e) => e.type === "content_block_delta");
    expect(delta.delta.text).toBe("ok");
  }
);

test("hooks: an error Kiro answers with, or an exception before the answer, is a status", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const answered = async (response: Response) => {
    const res = await ask(hook, response);
    return { status: res.status, headers: res.headers, error: await errorOf(res) };
  };
  // a 429 keeps Kiro's Retry-After, which OpenCode waits for
  const throttled = await answered(
    Response.json(
      { message: "Too many requests" },
      {
        status: 429,
        headers: {
          "retry-after": "7",
          "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/",
        },
      }
    )
  );
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("retry-after")).toBe("7");
  expect(throttled.error).toEqual({
    type: "rate_limit_error",
    message: "Kiro is rate limiting requests. Kiro said: Too many requests",
  });
  // an exception before any of the answer is a status too
  const streamed = await answered(
    stream(frame("ThrottlingException", { message: "slow down" }, "exception"))
  );
  expect(streamed.status).toBe(429);
  expect(streamed.error.message).toBe("Kiro is rate limiting requests. Kiro said: slow down");
});

test("hooks: a request the plugin can't handle says so, and isn't retried", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const event: HookEvent = {
    request: new Request("https://runtime.us-east-1.kiro.dev/messages", {
      method: "POST",
      body: "not json",
    }),
  };
  await hook("http.request").fn(event);
  const res: HookEvent = { request: event.request, response: await fetch(event.request) };
  await hook("http.response").fn(res);
  expect(res.response!.status).toBe(500);
  expect(res.response!.headers.get("x-should-retry")).toBe("false");
  expect((await errorOf(res.response!)).message).toStartWith(
    "The Kiro plugin failed on this request"
  );
});

test("hooks: a reply that breaks off after it began ends in an error event", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const broken = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(frame("assistantResponseEvent", { content: "Half" }));
      // the next message's header, and no more of it
      ctl.enqueue(frame("assistantResponseEvent", { content: " an answer" }).subarray(0, 20));
      ctl.close();
    },
  });
  const res = await ask(hook, new Response(broken, { status: 200 }));
  expect(res.status).toBe(200);
  const out = await sse(res);
  expect(out.map((e) => e.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ]);
  expect(out[4].error).toEqual({
    type: "api_error",
    message:
      "Kiro's reply broke off before it finished: the connection closed partway through an event",
  });
});

test("models: a listing Kiro fails is tried again, 5 and then 20 seconds later", async () => {
  signIn({ access: "tok" });
  const { ctx, saved } = fakeHost();
  let calls = 0;
  answer = async () => {
    calls++;
    if (calls < 3) return Response.json({ message: "busy" }, { status: 500 });
    return Response.json({ models: [{ modelId: "claude-y", modelName: "Claude Y" }] });
  };
  // the fake network answers on the event loop, so each step gives it a moment
  const settle = TestClock.withLive(Effect.sleep("20 millis"));
  await run(
    Effect.gen(function* () {
      yield* k.make(ctx);
      yield* settle;
      expect(calls).toBe(1);
      yield* TestClock.adjust("4 seconds");
      yield* settle;
      expect(calls).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* settle;
      expect(calls).toBe(2);
      yield* TestClock.adjust("20 seconds");
      yield* settle;
      expect(calls).toBe(3);
    }).pipe(Effect.provide(TestClock.layer()))
  );
  expect(saved).toEqual([[expect.objectContaining({ id: "claude-y", name: "Claude Y" })]]);
});

test("hooks: with no sign-in, the request answers with why instead of reaching Kiro", async () => {
  signOut();
  const { hook } = await load();
  const event: HookEvent = {
    request: messages({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
  };
  await hook("http.request").fn(event);
  expect(event.request.url).toStartWith("data:");
  // what OpenCode's HTTP client gets for the stand-in, which never leaves the process
  const res: HookEvent = { request: event.request, response: await fetch(event.request) };
  await hook("http.response").fn(res);
  expect(res.response!.status).toBe(401);
  expect((await errorOf(res.response!)).message).toContain("kiro-cli login");
});

// Kiro caches but says nothing of it: a real reply (2026-10-24) ends with
// these events and no tokenUsage, so no input, output or cache counts at all.
// Saying cache_read_input_tokens 0 would read as a cache that never hits.
const usageOf = async (res: Response) =>
  (await sse(res)).find((e) => e.type === "message_delta").usage;

test("hooks: a reply with no token counts leaves the cache out, and reckons the input", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const res = await ask(
    hook,
    stream(
      frame("assistantResponseEvent", { content: "OK" }),
      frame("metadataEvent", { stopReason: "END_TURN" }),
      frame("contextUsageEvent", { contextUsagePercentage: 11.032500267028809 }),
      frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.091 })
    )
  );
  // claude-x's window is 1000 tokens; "OK" is about 1 token
  expect(await usageOf(res)).toEqual({ input_tokens: 110, output_tokens: 1 });
});

test("hooks: a reply whose metadataEvent counts tokens tells them, cache included", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const tokenUsage = {
    uncachedInputTokens: 120,
    outputTokens: 3,
    cacheReadInputTokens: 9000,
    cacheWriteInputTokens: 0,
    totalTokens: 9123,
  };
  const res = await ask(
    hook,
    stream(
      frame("assistantResponseEvent", { content: "OK" }),
      frame("metadataEvent", { stopReason: "END_TURN", tokenUsage })
    )
  );
  expect(await usageOf(res)).toEqual({
    input_tokens: 120,
    output_tokens: 3,
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 0,
  });
});

test("hooks: an exception after the answer began ends the stream with an error event", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const res = await ask(
    hook,
    stream(
      frame("assistantResponseEvent", { content: "Hello" }),
      frame("ThrottlingException", { message: "slow down" }, "exception")
    )
  );
  expect(res.status).toBe(200);
  const out = await sse(res);
  expect(out.map((e) => e.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ]);
  expect(out[2].delta.text).toBe("Hello");
  expect(out[4].error.type).toBe("rate_limit_error");
});

test("hooks: a refresh failing after Kiro turned the token down is a status, not a stream", async () => {
  signIn({ access: "stale" });
  const { hook } = await load();
  answer = async () => new Response("", { status: 503 });
  const retried = await ask(hook, new Response("{}", { status: 403 }));
  expect(retried.status).toBe(502);
  expect((await errorOf(retried)).message).toStartWith("Couldn't refresh Kiro's sign-in");
  answer = async (request) =>
    request.url === "https://oidc.us-east-1.amazonaws.com/token"
      ? Response.json({}, { status: 400 })
      : new Response("", { status: 500 });
  const refused = await ask(hook, new Response("{}", { status: 403 }));
  expect(refused.status).toBe(401);
  expect((await errorOf(refused)).message).toContain("kiro-cli login");
});

// ---- usage: the sidebar's credits, end to end (the rest is in usage.test.ts) -----

// Get-Usage-Limits as Kiro answered it (2026-10-28) for a Kiro Pro account
// over its limit, the user's own details made up
const PRO_USAGE = {
  daysUntilReset: null,
  limits: null,
  nextDateReset: 1793491200,
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
      nextDateReset: 1793491200,
      overageCap: 40000,
      overageCapWithPrecision: 40000,
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

// the plugin loaded in a scope that stays open, as OpenCode keeps it, with
// Kiro's management API answering usage
const withPlugin = <A>(
  usage: object,
  use: (p: ReturnType<typeof fakeHost>) => Effect.Effect<A, unknown, any>
) => {
  answer = async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/Get-Usage-Limits")) throw new Error("unexpected " + url.pathname);
    return Response.json(usage);
  };
  const host = fakeHost();
  return run(
    Effect.gen(function* () {
      yield* k.make(host.ctx);
      return yield* use(host);
    })
  );
};
const usageOfRpc = (p: ReturnType<typeof fakeHost>, sessionIDs: string[] = []) =>
  p.rpc.usage!({ sessionIDs }, {});
// a reply through both hooks, its body read to the end
const replyIn = (p: ReturnType<typeof fakeHost>, sessionID: string, ...frames: Uint8Array[]) =>
  Effect.gen(function* () {
    const event: HookEvent = {
      request: messages({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
      sessionID,
    };
    yield* p.hooks["http.request"]!.fn(event);
    const res: HookEvent = { request: event.request, response: stream(...frames), sessionID };
    yield* p.hooks["http.response"]!.fn(res);
    yield* Effect.promise(() => sse(res.response!));
    // what a finished reply starts runs beside it
    yield* Effect.sleep("30 millis");
  });
const metering = (usage: number) =>
  frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage });

test("usage: a reply's meteringEvents add up, and a session's replies add up in storage", async () => {
  signIn({ access: "tok" });
  const { store, emitted, account, credits } = await withPlugin(PRO_USAGE, (p) =>
    Effect.gen(function* () {
      yield* replyIn(
        p,
        "ses_a",
        frame("assistantResponseEvent", { content: "OK" }),
        metering(0.091)
      );
      expect(p.store.get("credits/ses_a")).toBeCloseTo(0.091);
      yield* replyIn(
        p,
        "ses_a",
        frame("assistantResponseEvent", { content: "OK" }),
        metering(0.2),
        metering(0.05)
      );
      const out = yield* usageOfRpc(p, ["ses_a", "ses_b"]);
      return { ...p, account: out.account, credits: out.credits };
    })
  );
  expect(account).toMatchObject({ plan: "Kiro Pro", resetsAt: 1793491200000 });
  expect(store.get("credits/ses_a")).toBeCloseTo(0.341);
  expect(store.has("credits/ses_b")).toBe(false);
  expect(credits.ses_a).toBeCloseTo(0.341);
  expect(credits.ses_b).toBe(0);
  // each finished reply tells the sidebar to look again
  expect(emitted).toEqual(["updated", "updated"]);
});
