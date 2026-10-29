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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Effect, Layer, Option, Scope, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import { TestClock } from "effect/testing";
import { _internal as k } from "./index.ts";

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

// signIn writes a kiro-cli IAM Identity Center sign-in, as kiro-cli keeps it,
// in place of any before it. A null start or profile leaves it out.
function signIn({
  access = "old",
  expires = Date.now() + 60 * 60_000,
  refresh = "r1",
  start = "https://example.awsapps.com/start" as string | null,
  profile = PROFILE as string | null,
} = {}) {
  rmSync(dbPath, { force: true });
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
    refresh_token: refresh,
    expires_at: new Date(expires).toISOString(),
    region: "us-east-1",
    ...(start ? { start_url: start } : {}),
    scopes: ["codewhisperer:conversations"],
  });
  put("auth_kv", "kirocli:odic:device-registration", { client_id: "cid", client_secret: "secret" });
  if (profile) put("state", "api.codewhisperer.profile", { arn: profile, profile_name: "TEST" });
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
  sessionID?: string,
) {
  const event: HookEvent = { request: messages(body), sessionID };
  await hook("http.request").fn(event);
  const res: HookEvent = { request: event.request, response, sessionID };
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

type Req = Parameters<typeof k.kiroRequest>[0];
type Conversation = ReturnType<typeof k.kiroRequest>["conversationState"];
const conversation = (req: Req, thinking?: Parameters<typeof k.kiroRequest>[3]) =>
  k.kiroRequest(req, "claude-sonnet-4.5", "", thinking).conversationState;
const resultsOf = (s: Conversation) =>
  (s.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? []).map(
    (r) => `${r.toolUseId}=${r.content[0]?.text}`,
  );
const NO_RESULT = "Tool use was interrupted and did not produce a result.";

// One turn's parallel tool_use blocks split over two consecutive assistant
// messages, answered by one user message (yetone/magpie#1275, the request
// as Claude Code sent it).
const splitTurn = (answered = ["a", "b"]): Req => ({
  messages: [
    { role: "user", content: "read a and b" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_a", name: "read", input: { path: "a" } }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_b", name: "read", input: { path: "b" } }],
    },
    {
      role: "user",
      content: answered.map((x) => ({
        type: "tool_result",
        tool_use_id: "toolu_" + x,
        content: x.toUpperCase() + "!",
      })),
    },
  ],
});

test("a turn's calls split over two assistant messages are answered by their real results", () => {
  const s = conversation(splitTurn());
  expect(s.history?.map((e) => Object.keys(e)[0])).toEqual([
    "userInputMessage",
    "assistantResponseMessage",
  ]);
  expect(s.history?.[1]?.assistantResponseMessage?.toolUses?.map((c) => c.toolUseId)).toEqual([
    "toolu_a",
    "toolu_b",
  ]);
  expect(resultsOf(s)).toEqual(["toolu_a=A!", "toolu_b=B!"]);
  expect(JSON.stringify(s)).not.toContain(NO_RESULT);
});

test("a call of a split turn that went unanswered is still answered for", () => {
  expect(resultsOf(conversation(splitTurn(["b"])))).toEqual(["toolu_b=B!", `toolu_a=${NO_RESULT}`]);
});

// Kiro's generateAssistantResponse has no field for the answer's format, so
// a request's structured output is told to the model in the system prompt.
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const told =
  'Respond with a single JSON value and nothing else, matching this JSON schema:\n{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}.';
const opening = (req: Req, thinking?: Parameters<typeof k.kiroRequest>[3]) => {
  const s = conversation(req, thinking);
  return (s.history?.[0] ?? s.currentMessage).userInputMessage?.content;
};

test("output_config.format's schema is told at the end of the system prompt", () => {
  const req: Req = {
    system: "Be brief.",
    messages: [{ role: "user", content: "hi" }],
    output_config: { format: { type: "json_schema", schema } },
  };
  expect(opening(req)).toBe("Be brief.\n\n" + told + "\n\nhi");
});

test("with no system prompt the schema is the whole of it, after a thinking budget", () => {
  const req: Req = {
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "high", format: { type: "json_schema", schema } },
  };
  expect(opening(req)).toBe(told + "\n\nhi");
  const thinking = k.thinkingOf(req, "claude-sonnet-4.5", undefined);
  expect(thinking).toEqual({ budget: 30000 });
  expect(opening(req, thinking)).toBe(
    "<thinking_mode>enabled</thinking_mode><max_thinking_length>30000</max_thinking_length>\n" +
      told +
      "\n\nhi",
  );
});

test("the AI SDK's output_format is told too", () => {
  const req: Req = {
    system: [{ type: "text", text: "Be brief." }],
    messages: [{ role: "user", content: "hi" }],
    output_format: { type: "json_schema", schema },
  };
  expect(opening(req)).toBe("Be brief.\n\n" + told + "\n\nhi");
});

test("a request with no format, or one with no schema, is sent without one", () => {
  for (const extra of [
    {},
    { output_config: { effort: "low" } },
    { output_config: { format: { type: "json_schema" } } },
    { output_config: { format: { type: "text" } } },
  ]) {
    const req: Req = { system: "Be brief.", messages: [{ role: "user", content: "hi" }], ...extra };
    expect(opening(req)).toBe("Be brief.\n\nhi");
  }
});

// A tool's images reach the model (yetone/magpie#1861): Codex's view_image
// answers with a tool_result holding an image block. Kiro's tool results
// carry text alone, so the image goes with the message that answers the call.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";
type Blocks = Exclude<NonNullable<Req["messages"]>[number]["content"], string | undefined>;
const image = (data: string, media_type = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type, data },
});
const viewImage = (content: Blocks): Req & { messages: NonNullable<Req["messages"]> } => ({
  model: "claude-sonnet-4.5",
  system: [{ type: "text", text: "You are Codex." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "take a screenshot and look at it" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_view1", name: "view_image", input: { path: "/tmp/a.png" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_view1",
          content,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ],
  tools: [
    {
      name: "view_image",
      description: "View a local image",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
});

test("a tool's image goes with the message that answers its call", () => {
  const u = conversation(viewImage([image(PNG)])).currentMessage.userInputMessage;
  expect(u.images).toEqual([{ format: "png", source: { bytes: PNG } }]);
  expect(u.userInputMessageContext?.toolResults).toEqual([
    { toolUseId: "call_view1", status: "success", content: [{ text: "(no output)" }] },
  ]);
});

test("a tool's text and images both go, every image in order", () => {
  const u = conversation(
    viewImage([
      { type: "text", text: "Screenshot of Finder" },
      image(PNG),
      image(JPG, "image/jpeg"),
    ]),
  ).currentMessage.userInputMessage;
  expect(u.userInputMessageContext?.toolResults?.[0]?.content).toEqual([
    { text: "Screenshot of Finder" },
  ]);
  expect(u.images?.map((i) => i.format)).toEqual(["png", "jpeg"]);
});

test("an image named only by a URL has no bytes to send and is left out", () => {
  const s = conversation(viewImage([{ type: "image", source: { type: "url" } }]));
  expect(s.currentMessage.userInputMessage.images).toBeUndefined();
});

test("only the latest tool image is sent again, as Kiro's own agent sends only the latest", () => {
  const r = viewImage([image(PNG)]);
  r.messages.push(
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_view2", name: "view_image", input: { path: "/tmp/b.jpg" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_view2", content: [image(JPG, "image/jpeg")] },
      ],
    },
  );
  const s = conversation(r);
  expect(s.currentMessage.userInputMessage.images).toEqual([
    { format: "jpeg", source: { bytes: JPG } },
  ]);
  for (const e of s.history ?? []) expect(e.userInputMessage?.images).toBeUndefined();
});

// Kiro takes Bedrock's cachePoint ({"type":"default"}) on a user message, on
// an assistant message and as an entry of the tools; the caller's
// cache_control marks become them.
const EPH = { type: "ephemeral" };
const POINT = { type: "default" } as const;

test("Claude Code's cache marks go on the messages they end up in", () => {
  // where Claude Code 2.1.296 put its marks, from a captured request (texts
  // cut short): the last two system blocks, and the last message, the
  // system-role message holding a hook's context after a tool result
  const bash = {
    name: "Bash",
    description: "Run a command",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
  };
  const s = conversation({
    model: "claude-sonnet-4.5",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2" },
      { type: "text", text: "You are a Claude agent.", cache_control: EPH },
      { type: "text", text: "You are an agent working with the user …", cache_control: EPH },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nAttribution …</system-reminder>" },
          { type: "text", text: "run echo hi" },
        ],
      },
      { role: "system", content: "# Environment\nYou have been invoked in …" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo hi" } },
        ],
      },
      {
        role: "user",
        content: [{ tool_use_id: "toolu_01", type: "tool_result", is_error: false, content: "hi" }],
      },
      {
        role: "system",
        content: [{ type: "text", text: "PreToolUse:Bash hook context: …", cache_control: EPH }],
      },
    ],
    tools: [bash],
  });
  // the instructions are at the head of the first message, so its mark
  // covers them; the hook's context joins the tool result's message
  expect(s.history?.[0]?.userInputMessage?.cachePoint).toEqual(POINT);
  expect(s.history?.[1]?.assistantResponseMessage?.cachePoint).toBeUndefined();
  expect(s.currentMessage.userInputMessage.cachePoint).toEqual(POINT);
  expect(s.currentMessage.userInputMessage.userInputMessageContext?.tools).toEqual([
    {
      toolSpecification: {
        name: "Bash",
        description: "Run a command",
        inputSchema: { json: bash.input_schema },
      },
    },
  ]);
});

test("a marked tool is followed by a cachePoint, and marked messages get one each", () => {
  const s = conversation({
    system: "You are Codex.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: EPH }] },
      { role: "assistant", content: [{ type: "text", text: "hello", cache_control: EPH }] },
      { role: "user", content: "and now?" },
    ],
    tools: [
      { name: "a", input_schema: { type: "object", properties: {} } },
      { name: "b", input_schema: { type: "object", properties: {} }, cache_control: EPH },
    ],
  });
  expect(
    s.currentMessage.userInputMessage.userInputMessageContext?.tools?.map((t) => Object.keys(t)[0]),
  ).toEqual(["toolSpecification", "toolSpecification", "cachePoint"]);
  expect(s.history?.[0]?.userInputMessage?.cachePoint).toEqual(POINT);
  expect(s.history?.[1]?.assistantResponseMessage?.cachePoint).toEqual(POINT);
  expect(s.currentMessage.userInputMessage.cachePoint).toBeUndefined();
});

test("nothing marked, no cachePoint sent", () => {
  const s = conversation({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "again" },
    ],
  });
  expect(JSON.stringify(s)).not.toContain("cachePoint");
});

test("at most 4 cachePoints, the last ones kept", () => {
  const msgs: NonNullable<Req["messages"]> = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: "q" + i, cache_control: EPH }] });
    msgs.push({ role: "assistant", content: "a" + i });
  }
  msgs.push({ role: "user", content: [{ type: "text", text: "last", cache_control: EPH }] });
  const s = conversation({
    messages: msgs,
    tools: [{ name: "t", input_schema: { type: "object", properties: {} }, cache_control: EPH }],
  });
  expect(JSON.stringify(s).match(/cachePoint/g)?.length).toBe(4);
  expect(s.currentMessage.userInputMessage.cachePoint).toEqual(POINT);
  expect(
    s.currentMessage.userInputMessage.userInputMessageContext?.tools?.some((t) => t.cachePoint),
  ).toBe(false);
  expect(
    s.history
      ?.filter((e) => e.userInputMessage?.cachePoint)
      .map((e) => e.userInputMessage?.content),
  ).toEqual(["q3", "q4", "q5"]);
});

// Kiro refuses a tool named past 64 characters (REQUEST_BODY_INVALID).
// Claude Code names a plugin's MCP tools mcp__plugin_<plugin>_<server>__<tool>,
// which runs past it (yetone/magpie#1393, the reporter's names).
const LONG = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation"; // 71
const LONG2 = "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide"; // 70

test("every tool name Kiro is sent is one it takes, and a short one is kept", () => {
  const empty = { type: "object", properties: {} };
  const s = conversation({
    model: "claude-opus-4.5",
    messages: [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: LONG, input: { q: "workers" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }],
      },
    ],
    tools: [
      { name: LONG, description: "Search Cloudflare docs", input_schema: empty },
      { name: LONG2, description: "Guide", input_schema: empty },
      { name: "Read", description: "read", input_schema: empty },
    ],
  });
  const names = (s.currentMessage.userInputMessage.userInputMessageContext?.tools ?? []).map(
    (t) => t.toolSpecification?.name ?? "",
  );
  for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(names[2]).toBe("Read");
  expect(new Set(names).size).toBe(3);
  expect(names[0]).toStartWith("mcp__plugin_cloudflare_cloudflare-docs__");
  // the call in the history names the tool as its declaration does
  expect(s.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe(names[0]!);
  expect(resultsOf(s)).toEqual(["toolu_1=found"]);
});

test("a tool name is shortened the same way each turn", () => {
  expect(k.toolName(LONG)).toBe(k.toolName(LONG));
  expect(k.toolName(LONG)).not.toBe(k.toolName(LONG2));
  expect(k.toolName(LONG).length).toBeLessThanOrEqual(64);
  expect(k.toolName("a.b")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(k.toolNames({ tools: [{ name: LONG }, { name: "Read" }] })).toEqual(
    new Map([[k.toolName(LONG), LONG]]),
  );
});

// Claude Code's levels are low, medium, high, xhigh and max; xhigh isn't
// routed as max (magpie #120)
test("efforts: xhigh keeps its own meaning, and a model that doesn't think offers no levels", () => {
  expect(
    k.thinkingOf({ output_config: { effort: "xhigh" } }, "claude-opus-4.5", undefined),
  ).toEqual({ budget: 50000 });
  const listsXhigh = k.modelOf({
    modelId: "claude-y",
    additionalModelRequestFieldsSchema: {
      properties: { output_config: { properties: { effort: { enum: ["high", "xhigh", "max"] } } } },
    },
  });
  expect(k.modelInfo(listsXhigh).variants.map((v): string => v.id)).toEqual([
    "high",
    "xhigh",
    "max",
  ]);
  expect(
    k.thinkingOf({ output_config: { effort: "xhigh" } }, "claude-y", listsXhigh).fields
      ?.output_config,
  ).toEqual({ effort: "xhigh" });
  const deepseek = k.modelOf({ modelId: "deepseek-3.2" });
  expect(k.modelInfo(deepseek).variants).toEqual([]);
  expect(k.thinkingOf({ output_config: { effort: "high" } }, "deepseek-3.2", deepseek)).toEqual({});
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

// Kiro turns away an image whose Base64 is over 5 MiB (magpie-community/
// plugins#428): Codex's view_image gave a PNG of 4,171,428 bytes, 5,561,904
// as Base64, and Kiro refused that turn and every later one, as the image
// stays in history. The fixtures are built here at those sizes.
const LIMIT = 5 * 1024 * 1024;
const REPORTED_RAW = 4171428;
const REPORTED_B64 = 5561904;

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8; // bit depth
  d[9] = 2; // RGB
  return pngChunk("IHDR", d);
};

// png is a w×h RGB PNG of noise (seeded, so the same each run: the worst
// case for a codec) or of flat grey, made exactly size bytes long with a
// private ancillary chunk, which no decoder looks at.
function png(
  w: number,
  h: number,
  { noise = true, size }: { noise?: boolean; size?: number } = {},
) {
  const row = 1 + w * 3;
  const rows = Buffer.alloc(h * row, 0x80);
  if (noise) {
    let x = 0x9e3779b9;
    for (let i = 0; i < rows.length; i++) {
      if (i % row === 0) {
        rows[i] = 0;
        continue;
      }
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      rows[i] = x & 0xff;
    }
  } else for (let y = 0; y < h; y++) rows[y * row] = 0;
  const idat = pngChunk("IDAT", deflateSync(rows, { level: noise ? 0 : 9 }));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const file = Buffer.concat([PNG_SIG, ihdr(w, h), idat, end]);
  if (size === undefined) return file;
  const pad = size - file.length - 12;
  if (pad < 0) throw new Error(`a ${w}x${h} PNG is ${file.length} bytes, over ${size}`);
  return Buffer.concat([PNG_SIG, ihdr(w, h), pngChunk("pdNg", Buffer.alloc(pad, 0x2a)), idat, end]);
}

// a header saying 20000×20000 (400M pixels) with almost nothing behind it
function bomb(size: number) {
  const idat = pngChunk("IDAT", deflateSync(Buffer.alloc(1000)));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const head = Buffer.concat([PNG_SIG, ihdr(20000, 20000)]);
  const pad = size - head.length - idat.length - end.length - 12;
  return Buffer.concat([head, pngChunk("pdNg", Buffer.alloc(pad, 0x2a)), idat, end]);
}

const meta = (s: string) => new Bun.Image(Buffer.from(s, "base64")).metadata();

// the reporter's image: a 1389×1000 noise PNG, 4,171,428 bytes
const reported = png(1389, 1000, { size: REPORTED_RAW });
const REPORTED = reported.toString("base64");

// Codex's turn: view_image answered with the image, then (when follow) a
// reply and a text-only question, the image still in history
function codex(data: string, follow = false) {
  const r = viewImage([image(data)]);
  if (follow)
    r.messages.push(
      { role: "assistant", content: [{ type: "text", text: "It is a contact sheet." }] },
      { role: "user", content: [{ type: "text", text: "now make it smaller" }] },
    );
  return r;
}

// fitted is each request as Kiro would be sent it, fitted by one Images
const fitted = (...reqs: Req[]) =>
  run(
    Effect.gen(function* () {
      const images = yield* k.Images;
      const out: Conversation[] = [];
      for (const r of reqs)
        out.push((yield* images.fit(k.kiroRequest(r, "claude-opus-4.5", ""))).conversationState);
      return out;
    }),
  );
const fit = async (req: Req) => (await fitted(req))[0]!;
const usersOf = (s: Conversation) =>
  [...(s.history ?? []).map((e) => e.userInputMessage), s.currentMessage.userInputMessage].filter(
    (u) => u !== undefined,
  );
const imagesOf = (s: Conversation) => usersOf(s).flatMap((u) => u.images ?? []);
// the conversation with its images' bytes and format left out, which
// fitting may change
const shape = (s: Conversation) => {
  const c = structuredClone(s) as Partial<Conversation>;
  delete c.conversationId;
  for (const u of usersOf(c as Conversation))
    u.images = u.images?.map(() => ({ format: "", source: { bytes: "…" } }));
  return c;
};

test("the fixture is the reported image's size: under 5 MiB as a file, over it as Base64", () => {
  expect(reported.length).toBe(REPORTED_RAW);
  expect(REPORTED.length).toBe(REPORTED_B64);
  // and kiroRequest alone leaves it as it is, which is what Kiro refused
  const s = k.kiroRequest(codex(REPORTED), "claude-opus-4.5", "").conversationState;
  expect(s.currentMessage.userInputMessage.images?.[0]?.source.bytes.length).toBe(REPORTED_B64);
});

test("the reported tool image goes under the limit as an image Kiro can read, the conversation otherwise the same", async () => {
  const req = codex(REPORTED);
  const before = structuredClone(req);
  const s = await fit(req);
  const [i] = imagesOf(s);
  expect(imagesOf(s)).toHaveLength(1);
  expect(i!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  // it decodes as the kind it is declared as, the same shape
  const m = await meta(i!.source.bytes);
  expect<string>(m.format).toBe(i!.format);
  expect(m.width / m.height).toBeCloseTo(1389 / 1000, 2);
  expect(shape(s)).toEqual(shape(k.kiroRequest(req, "claude-opus-4.5", "").conversationState));
  // the caller's request is untouched
  expect(req).toEqual(before);
}, 60_000);

test("a text-only turn after the image goes too: the image in history is fitted, nothing else moves", async () => {
  const req = codex(REPORTED, true);
  const s = await fit(req);
  const plain = k.kiroRequest(req, "claude-opus-4.5", "").conversationState;
  // the image stays where the latest-image rule left it, in history
  expect(s.currentMessage.userInputMessage.images).toBeUndefined();
  expect(s.currentMessage.userInputMessage.content).toBe("now make it smaller");
  const where = (c: Conversation) => usersOf(c).map((u) => u.images?.length ?? 0);
  expect(where(s)).toEqual(where(plain));
  expect(imagesOf(s)).toHaveLength(1);
  expect(imagesOf(s)[0]!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(shape(s)).toEqual(shape(plain));
}, 60_000);

test("at the limit an image is sent byte for byte; one Base64 quad over, it is fitted", async () => {
  // 3,932,160 bytes is 5,242,880 Base64 characters, no padding;
  // 3,932,159 is the same length ending in "="; 3,932,161 is 5,242,884
  const b64 = (size: number) => png(64, 48, { noise: false, size }).toString("base64");
  const [at, padded, over] = [b64(3932160), b64(3932159), b64(3932161)];
  expect([at.length, padded.length, over.length]).toEqual([LIMIT, LIMIT, LIMIT + 4]);
  expect(padded).toEndWith("=");
  for (const data of [at, padded]) {
    const [i] = imagesOf(await fit(codex(data)));
    expect(i).toEqual({ format: "png", source: { bytes: data } });
  }
  const [i] = imagesOf(await fit(codex(over)));
  expect(i!.source.bytes.length).toBeLessThan(LIMIT);
  const m = await meta(i!.source.bytes);
  expect([m.format, m.width, m.height]).toEqual(["png", 64, 48]);
});

test("small images beside a large one are left as they are, in their order", async () => {
  const small = png(8, 8, { noise: false }).toString("base64");
  const s = await fit(
    viewImage([image(small), image(REPORTED), { type: "text", text: "two images" }, image(small)]),
  );
  const got = s.currentMessage.userInputMessage.images ?? [];
  expect(got).toHaveLength(3);
  expect(got[0]).toEqual({ format: "png", source: { bytes: small } });
  expect(got[2]).toEqual({ format: "png", source: { bytes: small } });
  expect(got[1]!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(
    s.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.content,
  ).toEqual([{ text: "two images" }]);
}, 60_000);

test("an image that can't be read, or claims too many pixels, becomes a note and the turn still goes", async () => {
  const junk = Buffer.alloc(4_000_000, 0x5a).toString("base64");
  const huge = bomb(4_000_000).toString("base64");
  expect(junk.length).toBeGreaterThan(LIMIT);
  expect(huge.length).toBeGreaterThan(LIMIT);
  for (const [data, why] of [
    [junk, "it couldn't be read as an image"],
    [huge, "it has too many pixels to resize"],
  ] as const) {
    const s = await fit(codex(data, true));
    expect(imagesOf(s)).toEqual([]);
    const noted = usersOf(s).find((u) => u.content.includes("was left out"));
    expect(noted?.content).toContain(why);
    expect(noted?.content).toContain("5.0 MB");
    // the note names no bytes and no path
    expect(noted!.content.length).toBeLessThan(300);
    expect(noted?.content).not.toContain("/tmp");
    // the tool's answer is still paired with its call
    expect(noted?.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe("call_view1");
    expect(s.currentMessage.userInputMessage.content).toBe("now make it smaller");
  }
});

test("an image is fitted once, and the next turn sends the same fitted bytes", async () => {
  const real = Bun.Image;
  let made = 0;
  Bun.Image = class extends real {
    constructor(...a: ConstructorParameters<typeof real>) {
      super(...a);
      made++;
    }
  };
  try {
    const flat = png(64, 48, { noise: false, size: 3932161 + 3 * 7 }).toString("base64");
    let once = 0;
    const [a, b] = await run(
      Effect.gen(function* () {
        const images = yield* k.Images;
        const a = yield* images.fit(k.kiroRequest(codex(flat), "claude-opus-4.5", ""));
        once = made;
        const b = yield* images.fit(k.kiroRequest(codex(flat, true), "claude-opus-4.5", ""));
        return [a, b].map((r) => r.conversationState);
      }),
    );
    expect(once).toBeGreaterThan(0);
    expect(made).toBe(once);
    expect(imagesOf(b!)[0]!.source.bytes).toBe(imagesOf(a!)[0]!.source.bytes);
  } finally {
    Bun.Image = real;
  }
});

test("a host without Bun.Image sends a note in the image's place", async () => {
  const real = Bun.Image;
  (Bun as { Image?: unknown }).Image = undefined;
  try {
    const flat = png(64, 48, { noise: false, size: 3932161 + 3 * 11 }).toString("base64");
    const s = await fit(codex(flat));
    expect(imagesOf(s)).toEqual([]);
    expect(s.currentMessage.userInputMessage.content).toContain(
      "this plugin host can't resize images",
    );
  } finally {
    Bun.Image = real;
  }
});

test("hooks: Kiro is sent the fitted image", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const event: HookEvent = { request: messages(codex(REPORTED, true)) };
  await hook("http.request").fn(event);
  expect(event.request.url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
  const body = (await event.request.json()) as ReturnType<typeof k.kiroRequest>;
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
      frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.091 }),
    ),
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
      frame("metadataEvent", { stopReason: "END_TURN", tokenUsage }),
    ),
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
      frame("ThrottlingException", { message: "slow down" }, "exception"),
    ),
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

test("hooks: a validation exception before the answer is a 400, compacting one that is too long", async () => {
  signIn({ access: "tok" });
  const { hook } = await load();
  const exception = (message: string) =>
    stream(frame("ValidationException", { message }, "exception"));
  const long = await ask(hook, exception("Input is too long."));
  expect(long.status).toBe(400);
  expect((await errorOf(long)).message).toStartWith(
    "prompt is too long for this model's context window",
  );
  const bad = await ask(hook, exception("bad field"));
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toEqual({
    type: "invalid_request_error",
    message: "Kiro rejected the request. Kiro said: bad field",
  });
});

test("an error Kiro gives no words for still says what it was", () => {
  expect(k.failure(500, "")).toEqual({ status: 500, message: "Kiro had a server error" });
  expect(k.failure(418, "")).toEqual({ status: 418, message: "Kiro answered HTTP 418" });
});

// the account's credentials, or why there are none
const credentials = (rejected?: string) =>
  run(Effect.flatMap(k.KiroAccount, (a) => a.credentials(rejected)));
const credentialsError = (rejected?: string) =>
  run(Effect.flip(Effect.flatMap(k.KiroAccount, (a) => a.credentials(rejected))));
const OIDC = "https://oidc.us-east-1.amazonaws.com/token";

test("one refresh at a time: two requests at once spend the refresh token once", async () => {
  signIn({ expires: Date.now() - 1000 });
  const refreshes: unknown[] = [];
  answer = async (request) => {
    refreshes.push(JSON.parse(textOf(request)));
    await Bun.sleep(30);
    return Response.json({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 });
  };
  const both = await run(
    Effect.gen(function* () {
      const account = yield* k.KiroAccount;
      return yield* Effect.all([account.credentials(), account.credentials()], {
        concurrency: 2,
      });
    }),
  );
  expect(both.map((a) => a.token)).toEqual(["new", "new"]);
  expect(refreshes).toHaveLength(1);
});

test("a refresh whose write-back failed isn't repeated with the refresh token it spent", async () => {
  signIn({ expires: Date.now() - 1000 });
  const refreshes: unknown[] = [];
  answer = async (request) => {
    refreshes.push(JSON.parse(textOf(request)));
    return Response.json({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 });
  };
  // a database the plugin may read but not write: the write-back can't land
  chmodSync(dbPath, 0o444);
  try {
    const tokens = await run(
      Effect.gen(function* () {
        const account = yield* k.KiroAccount;
        const a = yield* account.credentials();
        const b = yield* account.credentials();
        return [a.token, b.token];
      }),
    );
    expect(tokens).toEqual(["new", "new"]);
    expect(refreshes).toHaveLength(1);
  } finally {
    chmodSync(dbPath, 0o644);
  }
  expect(stored().access_token).toBe("old");
});

test("a refresh that fails says why: a refused one asks for a sign-in, another is retried", async () => {
  signIn({ expires: Date.now() - 1000 });
  for (const status of [400, 401, 403]) {
    answer = async () => Response.json({ error: "invalid_grant" }, { status });
    expect(await credentialsError()).toMatchObject({
      _tag: "SignInError",
      message: "Kiro's sign-in has expired. Run `kiro-cli login`, then try again.",
    });
  }
  answer = async () => new Response("", { status: 503 });
  expect(await credentialsError()).toMatchObject({
    _tag: "RefreshError",
    message: "Couldn't refresh Kiro's sign-in: oidc.us-east-1.amazonaws.com answered HTTP 503",
  });
  answer = offline;
  const unreachable = await credentialsError();
  expect(unreachable._tag).toBe("RefreshError");
  expect(unreachable.message).toStartWith("Couldn't refresh Kiro's sign-in: ");
  // with no refresh token there is nothing to ask AWS with
  signIn({ expires: Date.now() - 1000, refresh: "" });
  answer = async () => {
    throw new Error("AWS was asked");
  };
  expect(await credentialsError()).toMatchObject({ _tag: "SignInError" });
});

test("hooks: a refresh failing after Kiro turned the token down is a status, not a stream", async () => {
  signIn({ access: "stale" });
  const { hook } = await load();
  answer = async () => new Response("", { status: 503 });
  const retried = await ask(hook, new Response("{}", { status: 403 }));
  expect(retried.status).toBe(502);
  expect((await errorOf(retried)).message).toStartWith("Couldn't refresh Kiro's sign-in");
  answer = async (request) =>
    request.url === OIDC ? Response.json({}, { status: 400 }) : new Response("", { status: 500 });
  const refused = await ask(hook, new Response("{}", { status: 403 }));
  expect(refused.status).toBe(401);
  expect((await errorOf(refused)).message).toContain("kiro-cli login");
});

// A Builder ID sign-in has no profile of its own and Kiro won't list one for
// it; it is asked with the service profile kiro-cli and the IDE use
// (magpie-community/plugins#16: a Kiro Student account was offered Auto alone).
const BUILDER_ID = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const IDC = "arn:aws:codewhisperer:us-east-1:222222222222:profile/IDC";
const STUDENT = [
  { modelId: "auto", modelName: "auto" },
  { modelId: "claude-opus-5.5", modelName: "claude-opus-5.5" },
];
const path = (request: HttpClientRequest.HttpClientRequest) => new URL(request.url).pathname;

// management is Kiro's management API as a sign-in with no profile sees it:
// profiles listed (or a 403 for Builder ID), and models only for a profile
function management(profiles?: { arn: string }[]) {
  const seen = { profiles: 0, listedWith: [] as (string | undefined)[] };
  answer = async (request) => {
    if (path(request) === "/List-Available-Profiles") {
      seen.profiles++;
      if (profiles) return Response.json({ profiles });
      const message = "AWS Builder ID is not supported for this operation";
      return Response.json({ message, reason: null }, { status: 403 });
    }
    if (path(request) === "/List-Available-Models") {
      const p = Option.getOrUndefined(UrlParams.getFirst(request.urlParams, "profileArn"));
      seen.listedWith.push(p);
      if (p === BUILDER_ID || p === IDC) return Response.json({ models: STUDENT });
      return Response.json({ message: "profileArn is required" }, { status: 400 });
    }
    throw new Error("unexpected request to " + request.url);
  };
  return seen;
}

test("kiro-cli's Builder ID sign-in (its start URL, or none) is asked with Builder ID's profile", async () => {
  for (const start of ["https://view.awsapps.com/start", null]) {
    signIn({ start, profile: null });
    const seen = management();
    expect(await credentials()).toMatchObject({ profile: BUILDER_ID, region: "us-east-1" });
    expect(seen.profiles).toBe(0);
  }
});

test("models: a Builder ID account's own models are listed under Builder ID's profile", async () => {
  signIn({ start: null, profile: null });
  const seen = management();
  const { ctx, saved } = fakeHost();
  await run(
    Effect.gen(function* () {
      yield* k.make(ctx);
      for (let i = 0; i < 100 && !saved.length; i++) yield* Effect.sleep("10 millis");
    }),
  );
  expect(seen.listedWith).toEqual([BUILDER_ID]);
  expect((saved[0] as { id: string }[]).map((m) => m.id)).toEqual(["auto", "claude-opus-5.5"]);
});

test("an Identity Center sign-in with no profile has its own listed", async () => {
  signIn({ profile: null });
  const seen = management([{ arn: IDC }]);
  expect(await credentials()).toMatchObject({ profile: IDC });
  expect(seen.profiles).toBe(1);
});

test("an AWS sign-in whose profiles Kiro won't list for Builder ID takes Builder ID's profile", async () => {
  signIn({ profile: null });
  const seen = management();
  expect(await credentials()).toMatchObject({ profile: BUILDER_ID });
  expect(seen.profiles).toBe(1);
});

test("the Kiro IDE's Builder ID sign-in is asked with Builder ID's profile", async () => {
  rmSync(dbPath, { force: true });
  const ide = join(HOME, ".aws", "sso", "cache");
  mkdirSync(ide, { recursive: true });
  try {
    writeFileSync(
      join(ide, "kiro-auth-token.json"),
      JSON.stringify({
        accessToken: "ide",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        authMethod: "IdC",
        provider: "BuilderId",
        region: "us-east-1",
        clientIdHash: "h",
      }),
    );
    writeFileSync(join(ide, "h.json"), JSON.stringify({ clientId: "c", clientSecret: "s" }));
    const seen = management();
    expect(await credentials()).toMatchObject({ token: "ide", profile: BUILDER_ID });
    expect(seen.profiles).toBe(0);
  } finally {
    rmSync(join(HOME, ".aws"), { recursive: true, force: true });
  }
});

// ---- usage: the sidebar's credits ------------------------------------------------

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
// Kiro's management API answering usage (or a status)
const withPlugin = <A>(
  usage: object | number,
  use: (
    p: ReturnType<typeof fakeHost> & { asked: Record<string, string>[] },
  ) => Effect.Effect<A, unknown, any>,
  host = fakeHost(),
) => {
  const asked: Record<string, string>[] = [];
  answer = async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/Get-Usage-Limits")) throw new Error("unexpected " + url.pathname);
    asked.push(UrlParams.toRecord(request.urlParams) as Record<string, string>);
    return typeof usage === "number"
      ? Response.json({ message: "Not allowed", reason: null }, { status: usage })
      : Response.json(usage);
  };
  return run(
    Effect.gen(function* () {
      yield* k.make(host.ctx);
      return yield* use({ ...host, asked });
    }),
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
  const { store, emitted, credits } = await withPlugin(PRO_USAGE, (p) =>
    Effect.gen(function* () {
      yield* replyIn(
        p,
        "ses_a",
        frame("assistantResponseEvent", { content: "OK" }),
        metering(0.091),
      );
      expect(p.store.get("credits/ses_a")).toBeCloseTo(0.091);
      yield* replyIn(
        p,
        "ses_a",
        frame("assistantResponseEvent", { content: "OK" }),
        metering(0.2),
        metering(0.05),
      );
      const out = yield* usageOfRpc(p, ["ses_a", "ses_b"]);
      return { ...p, credits: out.credits };
    }),
  );
  expect(store.get("credits/ses_a")).toBeCloseTo(0.341);
  expect(store.has("credits/ses_b")).toBe(false);
  expect(credits.ses_a).toBeCloseTo(0.341);
  expect(credits.ses_b).toBe(0);
  // each finished reply tells the sidebar to look again
  expect(emitted).toEqual(["updated", "updated"]);
});

test("usage: a session's credits from an earlier run are read from storage", async () => {
  signIn({ access: "tok" });
  const host = fakeHost();
  host.store.set("credits/ses_old", 12.4);
  const out = await withPlugin(
    PRO_USAGE,
    (p) =>
      Effect.gen(function* () {
        yield* replyIn(
          p,
          "ses_old",
          frame("assistantResponseEvent", { content: "OK" }),
          metering(1),
        );
        return yield* usageOfRpc(p, ["ses_old"]);
      }),
    host,
  );
  expect(out.credits.ses_old).toBeCloseTo(13.4);
  expect(host.store.get("credits/ses_old")).toBeCloseTo(13.4);
});

test("usage: Get-Usage-Limits reads as the plan, its credits and the overage, and nothing of the user", async () => {
  signIn({ access: "tok" });
  const { out, asked } = await withPlugin(PRO_USAGE, (p) =>
    Effect.map(usageOfRpc(p), (out) => ({ out, asked: p.asked })),
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]).toEqual({
    origin: "KIRO_CLI",
    profileArn: PROFILE,
    resourceType: "CREDIT",
  });
  expect(out).toEqual({
    account: {
      plan: "Kiro Pro",
      resetsAt: 1793491200000,
      allowances: [
        {
          name: "Credits",
          used: 8978.62,
          limit: 1000,
          overage: {
            credits: 7978.62,
            charges: 319.144848378096,
            currency: "USD",
            rate: 0.04,
            cap: 40000,
            enabled: true,
          },
        },
      ],
      checkedAt: expect.any(Number),
    },
    credits: {},
  });
  expect(JSON.stringify(out)).not.toContain("someone@example.com");
  expect(JSON.stringify(out)).not.toContain("user-1");
});

test("usage: a free account shows its active trial, and a limit of 0 is left out", async () => {
  signIn({ access: "tok" });
  const free = {
    nextDateReset: 1793491200,
    overageConfiguration: { overageStatus: "DISABLED" },
    subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
    usageBreakdownList: [
      {
        displayNamePlural: "Credits",
        currentUsageWithPrecision: 12.5,
        usageLimitWithPrecision: 50,
        freeTrialInfo: {
          freeTrialStatus: "ACTIVE",
          currentUsageWithPrecision: 120.25,
          usageLimitWithPrecision: 500,
          freeTrialExpiry: 1794000000,
        },
      },
      { displayNamePlural: "Agentic requests", usageLimit: 0, currentUsage: 0 },
      {
        displayNamePlural: "Old trial",
        usageLimit: 10,
        freeTrialInfo: { freeTrialStatus: "EXPIRED", usageLimit: 100 },
      },
    ],
  };
  const out = await withPlugin(free, (p) => usageOfRpc(p));
  expect(out.account.plan).toBe("Kiro Free");
  expect(out.account.allowances).toEqual([
    {
      name: "Credits",
      used: 12.5,
      limit: 50,
      trial: { used: 120.25, limit: 500, expiresAt: 1794000000000 },
    },
    { name: "Old trial", used: 0, limit: 10 },
  ]);
});

test("usage: an account Kiro won't show is an error, not a failure", async () => {
  signIn({ access: "tok" });
  const out = await withPlugin(403, (p) => usageOfRpc(p, ["ses_x"]));
  expect(out).toEqual({
    account: null,
    error: "Kiro: Not allowed (HTTP 403)",
    credits: { ses_x: 0 },
  });
});
