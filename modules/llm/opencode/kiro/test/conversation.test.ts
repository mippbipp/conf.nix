// One turn of a conversation through src/conversation.ts's open: the Kiro
// request a Messages request becomes, and the Messages events Kiro's event
// stream comes back as. Run with BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import { type MessagesRequest, open } from "../src/conversation.ts";
import type { KiroModel } from "../src/models.ts";
import { errorOf, frame, sse } from "./eventstream.ts";
import { type Conversation, image, JPG, PNG, viewImage } from "./messages.ts";

type Req = MessagesRequest;

// models as Kiro lists them: one that takes Anthropic's thinking fields,
// one OpenAI's. A model not among them (claude-sonnet-4.5) thinks in the
// prompt, with a budget.
const CLAUDE_X: KiroModel = {
  id: "claude-x",
  name: "claude-x",
  context: 1000,
  output: 100,
  images: true,
  fields: "claude",
  efforts: ["low", "high"],
  off: true,
  summarized: true,
  maxTokens: [1024, 64000],
};
const GPT_X: KiroModel = {
  id: "gpt-x",
  name: "gpt-x",
  context: 1000,
  output: 100,
  images: false,
  fields: "openai",
  efforts: ["none", "low"],
};
const MODELS = [CLAUDE_X, GPT_X];

const request = (req: Req, profile = "") => open(req, MODELS).request(profile);
const conversation = (req: Req) => request(req).conversationState;
const resultsOf = (s: Conversation) =>
  (s.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? []).map(
    (r) => `${r.toolUseId}=${r.content[0]?.text}`
  );
const toolsOf = (s: Conversation) =>
  s.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
// the first message's text, where the instructions go
const opening = (req: Req) => {
  const s = conversation(req);
  return (s.history?.[0] ?? s.currentMessage).userInputMessage?.content;
};
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const EMPTY = { type: "object", properties: {} };

// answer is Kiro answering req's turn with frames, read as OpenCode reads it
const answer = (req: Req, frames: Uint8Array[], idleSeconds?: number) =>
  Effect.runPromise(
    open(req, MODELS).answer(Stream.fromIterable(frames), () => Effect.void, idleSeconds)
  );
const said = (content: string) => frame("assistantResponseEvent", { content });
const HI: Req = { model: "claude-x", messages: [{ role: "user", content: "hi" }] };

// ---- thinking ----------------------------------------------------------------------

const BUDGET = (n: number) =>
  `<thinking_mode>enabled</thinking_mode><max_thinking_length>${n}</max_thinking_length>`;

test("a model Kiro lists thinking fields for is sent them, from the variant's effort", () => {
  const fieldsOf = (model: string, extra: Partial<Req>) =>
    request({ ...HI, model, ...extra }).additionalModelRequestFields;
  expect(fieldsOf("claude-x", { output_config: { effort: "high" }, max_tokens: 99999 })).toEqual({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    max_tokens: 64000,
  });
  expect(fieldsOf("claude-x", { output_config: { effort: "none" } })).toEqual({
    thinking: { type: "disabled" },
  });
  expect(fieldsOf("gpt-x", { output_config: { effort: "low" } })).toEqual({
    reasoning: { effort: "low" },
  });
  expect(fieldsOf("claude-x", {})).toBeUndefined();
  // fields go instead of a budget in the prompt
  expect(opening({ ...HI, output_config: { effort: "high" } })).toBe("hi");
});

test("a model Kiro lists no fields for is told a thinking budget in the prompt", () => {
  const old = (extra: Partial<Req>) => ({ ...HI, model: "claude-sonnet-4.5", ...extra });
  expect(opening(old({ output_config: { effort: "medium" } }))).toBe(BUDGET(20000) + "\n\nhi");
  // Claude Code's xhigh isn't routed as max (magpie #120)
  expect(opening(old({ output_config: { effort: "xhigh" } }))).toBe(BUDGET(50000) + "\n\nhi");
  expect(opening(old({ thinking: { type: "enabled", budget_tokens: 12345 } }))).toBe(
    BUDGET(12345) + "\n\nhi"
  );
  expect(request(old({ output_config: { effort: "medium" } })).additionalModelRequestFields).toBe(
    undefined
  );
  // a model that doesn't think is told nothing
  expect(opening({ ...HI, model: "deepseek-3.2", output_config: { effort: "high" } })).toBe("hi");
});

test("a reply to a thinking budget has its <thinking> split off as thinking, however the tags fall", async () => {
  const budgeted: Req = { ...HI, model: "claude-sonnet-4.5", output_config: { effort: "high" } };
  const pieces = ["<think", "ing>\nI should", " look.</thi", "nking>\n\nHello"].map(said);
  const out = await sse(await answer(budgeted, pieces));
  expect(out.map((e) => [e.type, e.content_block?.type ?? e.delta?.type])).toEqual([
    ["message_start", undefined],
    ["content_block_start", "thinking"],
    ["content_block_delta", "thinking_delta"],
    ["content_block_delta", "thinking_delta"],
    ["content_block_stop", undefined],
    ["content_block_start", "text"],
    ["content_block_delta", "text_delta"],
    ["content_block_stop", undefined],
    ["message_delta", undefined],
    ["message_stop", undefined],
  ]);
  expect(out[2].delta.thinking + out[3].delta.thinking).toBe("I should look.");
  expect(out[6].delta.text).toBe("Hello");
  // without a budget the same reply is text, tags and all
  const plain = await sse(await answer(HI, pieces));
  expect(
    plain
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("")
  ).toBe("<thinking>\nI should look.</thinking>\n\nHello");
});

test("a reasoning signature goes on the thinking block it follows", async () => {
  const out = await sse(
    await answer(HI, [
      frame("reasoningContentEvent", { text: "hmm" }),
      frame("reasoningContentEvent", { signature: "sig-1" }),
      said("ok"),
    ])
  );
  expect(out.slice(1, 5)).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hmm" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-1" },
    },
    { type: "content_block_stop", index: 0 },
  ]);
});

// ---- why a reply stopped, and how it fails -----------------------------------------

test("Kiro's stop reason is said in Messages' words", async () => {
  const stopOf = async (stopReason: string) =>
    (await sse(await answer(HI, [said("x"), frame("metadataEvent", { stopReason })]))).find(
      (e) => e.type === "message_delta"
    ).delta.stop_reason;
  expect(await stopOf("END_TURN")).toBe("end_turn");
  expect(await stopOf("MAX_TOKENS")).toBe("max_tokens");
  expect(await stopOf("CONTENT_FILTERED")).toBe("refusal");
});

test("a malformed event stream is a 502 before the reply, an error event after it began", async () => {
  // a message that says it is 8 bytes long, under the 16 any message takes
  const malformed = new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
  const message = "Kiro's reply broke off before it finished: its event stream was malformed";
  const before = await answer(HI, [malformed]);
  expect(before.status).toBe(502);
  expect(await errorOf(before)).toEqual({ type: "api_error", message });
  const after = await sse(await answer(HI, [said("Half"), malformed]));
  expect(after.map((e) => e.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ]);
  expect(after[4].error).toEqual({ type: "api_error", message });
});

test("an error event Kiro sends among its events fails the reply as its kind says", async () => {
  const throttled = await answer(HI, [frame("throttlingError", { message: "slow down" })]);
  expect(throttled.status).toBe(429);
  expect(await errorOf(throttled)).toEqual({
    type: "rate_limit_error",
    message: "Kiro is rate limiting requests. Kiro said: slow down",
  });
  const out = await sse(
    await answer(HI, [said("Hi"), frame("internalServerException", { message: "boom" })])
  );
  expect(out.at(-1)).toEqual({
    type: "error",
    error: {
      type: "api_error",
      message: "Kiro had a server error. Kiro said: internalServerException: boom",
    },
  });
});

test("a reply that goes quiet is dropped as a stall, before its first event or after", async () => {
  const quietAfter = (...frames: Uint8Array[]) =>
    Effect.runPromise(
      open(HI, MODELS).answer(
        Stream.concat(Stream.fromIterable(frames), Stream.never),
        () => Effect.void,
        0.05
      )
    );
  const message =
    "Kiro stopped responding: nothing arrived for 0.05 seconds, so the reply was dropped";
  const before = await quietAfter();
  expect(before.status).toBe(504);
  expect(await errorOf(before)).toEqual({ type: "api_error", message });
  const after = await sse(await quietAfter(said("Hi")));
  expect(after[2].delta.text).toBe("Hi");
  expect(after.at(-1)).toEqual({ type: "error", error: { type: "api_error", message } });
});

// ---- the conversation Kiro is sent -------------------------------------------------

test("a mid-conversation system update is said as the user's; an effort-only one is dropped", () => {
  const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";
  const out = request(
    {
      model: "claude-x",
      system: [{ type: "text", text: "be brief" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "system", content: [] },
        { role: "system", content: [{ type: "text", text: "<reminder>" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    },
    PROFILE
  );
  expect(out.conversationState.history?.[0]?.userInputMessage?.content).toBe("be brief\n\nhi");
  expect(out.conversationState.currentMessage.userInputMessage.content).toBe("<reminder>\n\nagain");
  expect(out.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-x");
  expect(out.profileArn).toBe(PROFILE);
});

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

test("a call id Kiro wouldn't take is sent as a hash of it, the same for the call and its result", () => {
  const s = conversation({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "call 1/a", name: "read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call 1/a", content: "ok" }] },
    ],
  });
  // t_ and the first 32 characters of the id's SHA-256, as base64url
  const id = "t_dKO8E588m5ssoqSCsb5R69khJ98LSORM";
  expect(s.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe(id);
  expect(resultsOf(s)).toEqual([`${id}=ok`]);
});

test("a tool's output past 250,000 characters is cut there", () => {
  const resultOf = (content: string) =>
    resultsOf(
      conversation({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
        ],
      })
    )[0];
  const at = "x".repeat(250000);
  expect(resultOf(at)).toBe(`t1=${at}`);
  expect(resultOf(at + "yz")).toBe(`t1=${at}\n… (cut)`);
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
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "high", format: { type: "json_schema", schema } },
  };
  expect(opening(req)).toBe(BUDGET(30000) + "\n" + told + "\n\nhi");
  expect(opening({ ...req, output_config: { format: req.output_config!.format! } })).toBe(
    told + "\n\nhi"
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
    const req: Req = {
      model: "claude-x",
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    };
    expect(opening(req)).toBe("Be brief.\n\nhi");
  }
});

// A tool's images reach the model (yetone/magpie#1861): Codex's view_image
// answers with a tool_result holding an image block. Kiro's tool results
// carry text alone, so the image goes with the message that answers the call.
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
    ])
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
    }
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
  expect(toolsOf(s)).toEqual([
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
      { name: "a", input_schema: EMPTY },
      { name: "b", input_schema: EMPTY, cache_control: EPH },
    ],
  });
  expect(toolsOf(s).map((t) => Object.keys(t)[0])).toEqual([
    "toolSpecification",
    "toolSpecification",
    "cachePoint",
  ]);
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
    msgs.push(
      { role: "user", content: [{ type: "text", text: "q" + i, cache_control: EPH }] },
      { role: "assistant", content: "a" + i }
    );
  }
  msgs.push({ role: "user", content: [{ type: "text", text: "last", cache_control: EPH }] });
  const s = conversation({
    messages: msgs,
    tools: [{ name: "t", input_schema: EMPTY, cache_control: EPH }],
  });
  expect(JSON.stringify(s).match(/cachePoint/g)?.length).toBe(4);
  expect(s.currentMessage.userInputMessage.cachePoint).toEqual(POINT);
  expect(toolsOf(s).some((t) => t.cachePoint)).toBe(false);
  expect(
    s.history?.filter((e) => e.userInputMessage?.cachePoint).map((e) => e.userInputMessage?.content)
  ).toEqual(["q3", "q4", "q5"]);
});

// ---- tool names --------------------------------------------------------------------

// Kiro refuses a tool named past 64 characters (REQUEST_BODY_INVALID).
// Claude Code names a plugin's MCP tools mcp__plugin_<plugin>_<server>__<tool>,
// which runs past it (yetone/magpie#1393, the reporter's names).
const LONG = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation"; // 71
const LONG2 = "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide"; // 70
// LONG as Kiro is sent it: its head, and the first 12 hex digits of its SHA-256
const LONG_SENT = "mcp__plugin_cloudflare_cloudflare-docs__search_clou_44402c4dd80f";

const searched: Req = {
  model: "claude-opus-4.5",
  messages: [
    { role: "user", content: "search" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: LONG, input: { q: "workers" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }] },
  ],
  tools: [
    { name: LONG, description: "Search Cloudflare docs", input_schema: EMPTY },
    { name: LONG2, description: "Guide", input_schema: EMPTY },
    { name: "Read", description: "read", input_schema: EMPTY },
    { name: "a.b", description: "dotted", input_schema: EMPTY },
  ],
};

test("every tool name Kiro is sent is one it takes, the same each turn, and a short one is kept", () => {
  const s = conversation(searched);
  const names = toolsOf(s).map((t) => t.toolSpecification?.name ?? "");
  for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(names[0]).toBe(LONG_SENT);
  expect(names[1]).not.toBe(LONG_SENT);
  expect(names.slice(2)).toEqual(["Read", "a_b_2e7336dc8eba"]);
  // the call in the history names the tool as its declaration does
  expect(s.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe(LONG_SENT);
  expect(resultsOf(s)).toEqual(["toolu_1=found"]);
  // the next turn, opened afresh, names it the same way
  expect(toolsOf(conversation(searched))[0]?.toolSpecification?.name).toBe(LONG_SENT);
});

test("a call Kiro makes under a shortened name comes back under the caller's", async () => {
  const out = await sse(
    await answer(searched, [frame("toolUseEvent", { toolUseId: "t9", name: LONG_SENT })])
  );
  expect(out[1].content_block).toEqual({ type: "tool_use", id: "t9", name: LONG, input: {} });
  expect(out.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
});

test("a tool the conversation used and no longer offers is still declared, and its calls come back under its name", async () => {
  const req: Req = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "old.tool" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ],
    tools: [{ name: "Read", description: "read", input_schema: EMPTY }],
  };
  const s = conversation(req);
  expect(s.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe(
    "old_tool_92563f344437"
  );
  expect(toolsOf(s)).toEqual([
    { toolSpecification: { name: "Read", description: "read", inputSchema: { json: EMPTY } } },
    {
      toolSpecification: {
        name: "old_tool_92563f344437",
        description: "Tool",
        inputSchema: { json: EMPTY },
      },
    },
  ]);
  const out = await sse(
    await answer(req, [frame("toolUseEvent", { toolUseId: "t2", name: "old_tool_92563f344437" })])
  );
  expect(out[1].content_block.name).toBe("old.tool");
});
