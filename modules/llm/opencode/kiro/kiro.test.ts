// Run in this directory, with BUN_BE_BUN=1 so opencode acts as the Bun it
// ships, the runtime the plugin loads in:
//   BUN_BE_BUN=1 opencode test
//   BUN_BE_BUN=1 opencode install && BUN_BE_BUN=1 opencode run check   # tsc
// HOME is a throwaway dir so no real sign-in is read or written, and PATH is
// empty so kiro-cli is never run. The plugin reads both on each call. Its
// HTTP goes to the fake client below, never the network.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Scope, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { _internal as k } from "./kiro.ts";

const was = { HOME: process.env.HOME, PATH: process.env.PATH };
const HOME = mkdtempSync(join(tmpdir(), "kiro-test-"));
process.env.HOME = HOME;
process.env.PATH = "";
afterAll(() => {
  Object.assign(process.env, was);
  rmSync(HOME, { recursive: true, force: true });
});

const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";
const dbDir = join(HOME, ".local", "share", "kiro-cli");
const dbPath = join(dbDir, "data.sqlite3");

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
  }),
);
const layer = Layer.mergeAll(k.KiroAccount.layer, k.Images.layer).pipe(
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
);
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) => {
  const result = Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)));
  return result.finally(() => (answer = offline));
};
const textOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

// signIn writes a kiro-cli IAM Identity Center sign-in, as kiro-cli keeps it
function signIn({ access = "old", expires = Date.now() + 60 * 60_000 } = {}) {
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB)");
  const put = (table: "auth_kv" | "state", key: string, value: object) =>
    db
      .query(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`)
      .run(key, JSON.stringify(value));
  put("auth_kv", "kirocli:odic:token", {
    access_token: access,
    refresh_token: "r1",
    expires_at: new Date(expires).toISOString(),
    region: "us-east-1",
    start_url: "https://example.awsapps.com/start",
    scopes: ["codewhisperer:conversations"],
  });
  put("auth_kv", "kirocli:odic:device-registration", { client_id: "cid", client_secret: "secret" });
  put("state", "api.codewhisperer.profile", { arn: PROFILE, profile_name: "TEST" });
  db.close();
}
const stored = () => {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM auth_kv WHERE key = ?")
    .get("kirocli:odic:token");
  db.close();
  return JSON.parse(row?.value ?? "null");
};

// an AWS event stream message; the parser doesn't check the checksums
function frame(eventType: string, payload: object, messageType = "event") {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    return [n.length, ...n, 7, v.length >> 8, v.length & 255, ...v];
  };
  const headers = new Uint8Array([
    ...header(":message-type", messageType),
    ...header(messageType === "exception" ? ":exception-type" : ":event-type", eventType),
  ]);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  return out;
}
const stream = (...frames: Uint8Array[]) => new Response(new Blob(frames), { status: 200 });

// sse reads an Anthropic SSE body into its events
async function sse(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) =>
      JSON.parse(
        block
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ),
    );
}
// errorOf reads an Anthropic error body
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { type: string; message: string } }).error;

// the parts of a session hook's event the plugin reads
type HookEvent = { request: Request; response?: Response };
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
  const registered = { dispose: Effect.void };
  const ctx = {
    storage: {
      get: (key: string) => Effect.succeed(key === "models" ? SAVED : undefined),
      set: (_key: string, value: unknown) => Effect.sync(() => void saved.push(value)),
    },
    provider: {
      transform: (fn: (editor: { add: (d: (typeof added)[number]) => void }) => void) =>
        Effect.sync(() => {
          fn({ add: (d) => added.push(d) });
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
  };
  // the fake has only what the plugin calls
  return { ctx: ctx as unknown as Parameters<typeof k.make>[0], hooks, added, saved };
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
async function ask(hook: Awaited<ReturnType<typeof load>>["hook"], response: Response) {
  const event: HookEvent = {
    request: messages({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
  };
  await hook("http.request").fn(event);
  const res: HookEvent = { request: event.request, response };
  await hook("http.response").fn(res);
  return res.response!;
}

test("reads kiro-cli's sign-in, with the profile kiro-cli keeps apart from the token", async () => {
  signIn();
  const c = await run(k.readCLI());
  expect(c).toMatchObject({
    access: "old",
    method: "idc",
    profile: PROFILE,
    clientId: "cid",
    builderID: false,
  });
});

test("a token near its end is refreshed at AWS and written back for kiro-cli", async () => {
  signIn({ expires: Date.now() + 30_000 });
  const seen: [string, unknown][] = [];
  answer = async (request) => {
    seen.push([request.url, JSON.parse(textOf(request))]);
    return Response.json({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 });
  };
  const a = await run(
    Effect.gen(function* () {
      const account = yield* k.KiroAccount;
      return yield* account.credentials();
    }),
  );
  expect(a).toMatchObject({ token: "new", profile: PROFILE, region: "us-east-1" });
  expect(seen[0]![0]).toBe("https://oidc.us-east-1.amazonaws.com/token");
  expect(seen[0]![1]).toMatchObject({
    clientId: "cid",
    refreshToken: "r1",
    grantType: "refresh_token",
  });
  // written back with the fields kiro-cli keeps that the plugin doesn't read
  expect(stored()).toMatchObject({
    access_token: "new",
    refresh_token: "r2",
    scopes: ["codewhisperer:conversations"],
  });
});

test("models: each takes the thinking Kiro lists request fields for", () => {
  const claude = k.modelOf({
    modelId: "claude-x",
    tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 100 },
    supportedInputTypes: ["TEXT", "IMAGE"],
    additionalModelRequestFieldsSchema: {
      properties: {
        thinking: {
          properties: {
            type: { enum: ["adaptive", "disabled"] },
            display: { enum: ["summarized"] },
          },
        },
        output_config: { properties: { effort: { enum: ["low", "high"] } } },
        max_tokens: { minimum: 1024, maximum: 64000 },
      },
    },
  });
  const gpt = k.modelOf({
    modelId: "gpt-x",
    additionalModelRequestFieldsSchema: {
      properties: { reasoning: { properties: { effort: { enum: ["none", "low"] } } } },
    },
  });
  const old = k.modelOf({ modelId: "claude-sonnet-4.5" });
  const variants = (m: typeof claude): string[] => k.modelInfo(m).variants.map((v) => v.id);
  expect(variants(claude)).toEqual(["none", "low", "high"]);
  expect(variants(gpt)).toEqual(["none", "low"]);
  expect(variants(old)).toEqual(["low", "medium", "high", "max"]);
  expect(k.modelInfo(claude).capabilities.input).toEqual(["text", "image"]);

  const effort = (e: string, extra = {}) => ({ output_config: { effort: e }, ...extra });
  expect(k.thinkingOf(effort("high", { max_tokens: 99999 }), "claude-x", claude)).toEqual({
    fields: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      max_tokens: 64000,
    },
  });
  expect(k.thinkingOf(effort("none"), "claude-x", claude)).toEqual({
    fields: { thinking: { type: "disabled" } },
  });
  expect(k.thinkingOf(effort("low"), "gpt-x", gpt)).toEqual({
    fields: { reasoning: { effort: "low" } },
  });
  expect(k.thinkingOf(effort("medium"), "claude-sonnet-4.5", old)).toEqual({ budget: 20000 });
  expect(k.thinkingOf({}, "claude-x", claude)).toEqual({});
});

test("a mid-conversation system update is said as the user's; an effort-only one is dropped", () => {
  const out = k.kiroRequest(
    {
      system: [{ type: "text", text: "be brief" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "system", content: [] },
        { role: "system", content: [{ type: "text", text: "<reminder>" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    },
    "claude-x",
    PROFILE,
    { fields: { output_config: { effort: "low" } } },
  );
  expect(out.conversationState.history?.[0]?.userInputMessage?.content).toBe("be brief\n\nhi");
  expect(out.conversationState.currentMessage.userInputMessage.content).toBe("<reminder>\n\nagain");
  expect(out.additionalModelRequestFields).toEqual({ output_config: { effort: "low" } });
  expect(out.profileArn).toBe(PROFILE);
});

test("an image over Kiro's limit is made small enough to send", async () => {
  // a BMP of noise, which no lossless format makes small: 1200² pixels is
  // 4.3 MB, 5.8 MB as Base64
  const side = 1200;
  const pixels = side * side * 3;
  const bmp = Buffer.alloc(54 + pixels);
  bmp.write("BM", 0);
  bmp.writeUInt32LE(54 + pixels, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(side, 18);
  bmp.writeInt32LE(side, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  randomBytes(pixels).copy(bmp, 54);
  const b64 = bmp.toString("base64");
  const req = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/bmp", data: b64 } },
        ],
      },
    ],
  };
  const out = await run(
    Effect.gen(function* () {
      const images = yield* k.Images;
      return yield* images.fit(k.kiroRequest(req, "claude-x", ""));
    }),
  );
  const [image] = out.conversationState.currentMessage.userInputMessage.images ?? [];
  expect(b64.length).toBeGreaterThan(5 * 1024 * 1024);
  expect(image?.format).toBe("webp");
  expect(image?.source.bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
});

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
  const body = (await event.request.clone().json()) as ReturnType<typeof k.kiroRequest>;
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
      frame("metadataEvent", { stopReason: "TOOL_USE" }),
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
        frame("metadataEvent", { stopReason: "END_TURN" }),
      );
    };
    const res = await ask(hook, new Response("{}", { status }));
    answer = offline;
    expect(sent).toEqual(["Bearer fresh"]);
    const delta = (await sse(res)).find((e) => e.type === "content_block_delta");
    expect(delta.delta.text).toBe("ok");
  },
);

test("hooks: Kiro's failures keep their meaning for OpenCode", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const answered = async (response: Response) => {
    const res = await ask(hook, response);
    return { status: res.status, headers: res.headers, error: await errorOf(res) };
  };
  // OpenCode compacts the session on "prompt is too long"
  const overflow = await answered(
    Response.json(
      { message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" },
      { status: 400 },
    ),
  );
  expect(overflow.status).toBe(400);
  expect(overflow.error.message).toBe(
    "prompt is too long for this model's context window. Kiro said: Input is too long. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)",
  );
  // and doesn't retry a spent allowance
  const limit = await answered(
    Response.json({ message: "no", reason: "MONTHLY_REQUEST_COUNT" }, { status: 429 }),
  );
  expect(limit.status).toBe(402);
  expect(limit.error.type).toBe("billing_error");
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
      },
    ),
  );
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("retry-after")).toBe("7");
  expect(throttled.error).toEqual({
    type: "rate_limit_error",
    message: "Kiro is rate limiting requests. Kiro said: Too many requests",
  });
  const busy = await answered(
    Response.json({ message: "busy", reason: "INSUFFICIENT_MODEL_CAPACITY" }, { status: 429 }),
  );
  expect(busy.status).toBe(503);
  expect(busy.error.message).toStartWith("Kiro has no capacity for this model right now");
  // an exception before any of the answer is a status too
  const streamed = await answered(
    stream(frame("ThrottlingException", { message: "slow down" }, "exception")),
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
    "The Kiro plugin failed on this request",
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

test("a reply that goes quiet is dropped as a stall, before its first event or after", async () => {
  const quietAfter = (...frames: Uint8Array[]) =>
    Stream.concat(Stream.fromIterable(frames), Stream.never);
  const collect = (body: Stream.Stream<Uint8Array>) =>
    Effect.runPromise(Stream.runCollect(k.events(body, 0, undefined, 0.05)));
  const stall = {
    kind: "error" as const,
    status: 504,
    message: "Kiro stopped responding: nothing arrived for 0.05 seconds, so the reply was dropped",
  };
  expect(await collect(quietAfter())).toEqual([stall]);
  const after = await collect(quietAfter(frame("assistantResponseEvent", { content: "Hi" })));
  expect(after).toEqual([{ kind: "text", text: "Hi" }, stall]);
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
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(saved).toEqual([[expect.objectContaining({ id: "claude-y", name: "Claude Y" })]]);
});

test("hooks: with no sign-in, the request answers with why instead of reaching Kiro", async () => {
  rmSync(dbPath, { force: true });
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
