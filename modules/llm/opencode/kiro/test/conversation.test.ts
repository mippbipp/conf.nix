// One turn of a conversation through src/conversation.ts's open: the Kiro
// request a Messages request becomes, and the Messages events Kiro's event
// stream comes back as. Run with BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import {
  Array as Arr,
  Effect,
  Option,
  Record as Rec,
  Stream,
  String as Str,
} from "effect";

import { type MessagesRequest, open } from "../src/conversation.ts";
import type { KiroModel } from "../src/models.ts";
import { errorOf, frame, sse } from "./eventstream.ts";
import { type Conversation, image, JPG, PNG, viewImage } from "./messages.ts";

type Req = MessagesRequest;

// models as Kiro lists them: one that takes Anthropic's thinking fields,
// one OpenAI's. A model not among them (claude-sonnet-4.5) thinks in the
// prompt, with a budget.
const CLAUDE_X: KiroModel = {
  context: 1000,
  efforts: ["low", "high"],
  fields: "claude",
  id: "claude-x",
  images: true,
  maxTokens: [1024, 64_000],
  name: "claude-x",
  off: true,
  output: 100,
  summarized: true,
};
const GPT_X: KiroModel = {
  context: 1000,
  efforts: ["none", "low"],
  fields: "openai",
  id: "gpt-x",
  images: false,
  name: "gpt-x",
  output: 100,
};
const MODELS = [CLAUDE_X, GPT_X];

const request = (req: Req, profile = "") => open(req, MODELS).request(profile);
const conversation = (req: Req) => request(req).conversationState;
const resultsOf = (state: Conversation) =>
  Arr.map(
    state.currentMessage.userInputMessage.userInputMessageContext
      ?.toolResults ?? [],
    (result) => `${result.toolUseId}=${result.content[0]?.text}`
  );
type Entry = NonNullable<Conversation["history"]>[number];
type KiroTool = ReturnType<typeof toolsOf>[number];
const toolsOf = (state: Conversation) =>
  state.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
// the first message's text, where the instructions go
const opening = (req: Req) => {
  const state = conversation(req);
  return (state.history?.[0] ?? state.currentMessage).userInputMessage?.content;
};
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const EMPTY = { properties: {}, type: "object" };

// answer is Kiro answering req's turn with frames, read as OpenCode reads it
const answer = (req: Req, frames: Array<Uint8Array>, idleSeconds?: number) =>
  Effect.runPromise(
    open(req, MODELS).answer(
      Stream.fromIterable(frames),
      () => Effect.void,
      idleSeconds
    )
  );
const said = (content: string) => frame("assistantResponseEvent", { content });
const HI: Req = {
  messages: [{ content: "hi", role: "user" }],
  model: "claude-x",
};

// ---- thinking ----------------------------------------------------------------------

const BUDGET = (budget: number) =>
  `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;

test("a model Kiro lists thinking fields for is sent them, from the variant's effort", () => {
  const fieldsOf = (model: string, extra: Partial<Req>) =>
    request({ ...HI, model, ...extra }).additionalModelRequestFields;
  expect(
    fieldsOf("claude-x", {
      max_tokens: 99_999,
      output_config: { effort: "high" },
    })
  ).toEqual({
    max_tokens: 64_000,
    output_config: { effort: "high" },
    thinking: { display: "summarized", type: "adaptive" },
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

test("max_tokens is sent to a model that takes it, within its limits, with or without an effort", () => {
  const fieldsOf = (model: string, extra: Partial<Req>) =>
    request({ ...HI, model, ...extra }).additionalModelRequestFields;
  expect(fieldsOf("claude-x", { max_tokens: 2000 })).toEqual({
    max_tokens: 2000,
  });
  expect(fieldsOf("claude-x", { max_tokens: 500 })).toEqual({
    max_tokens: 1024,
  });
  expect(fieldsOf("claude-x", { max_tokens: 99_999 })).toEqual({
    max_tokens: 64_000,
  });
  // gpt-x lists no max_tokens field
  expect(fieldsOf("gpt-x", { max_tokens: 2000 })).toBeUndefined();
});

test("a model Kiro lists no fields for is told a thinking budget in the prompt", () => {
  const old = (extra: Partial<Req>) => ({
    ...HI,
    model: "claude-sonnet-4.5",
    ...extra,
  });
  expect(opening(old({ output_config: { effort: "medium" } }))).toBe(
    `${BUDGET(20_000)}\n\nhi`
  );
  // Claude Code's xhigh isn't routed as max (magpie #120)
  expect(opening(old({ output_config: { effort: "xhigh" } }))).toBe(
    `${BUDGET(50_000)}\n\nhi`
  );
  expect(
    opening(old({ thinking: { budget_tokens: 12_345, type: "enabled" } }))
  ).toBe(`${BUDGET(12_345)}\n\nhi`);
  expect(
    request(old({ output_config: { effort: "medium" } }))
      .additionalModelRequestFields
  ).toBe(undefined);
  // a model that doesn't think is told nothing
  expect(
    opening({ ...HI, model: "deepseek-3.2", output_config: { effort: "high" } })
  ).toBe("hi");
});

test("a reply to a thinking budget has its <thinking> split off as thinking, however the tags fall", async () => {
  const budgeted: Req = {
    ...HI,
    model: "claude-sonnet-4.5",
    output_config: { effort: "high" },
  };
  const pieces = Arr.map(
    ["<think", "ing>\nI should", " look.</thi", "nking>\n\nHello"],
    (piece) => said(piece)
  );
  const out = await sse(await answer(budgeted, pieces));
  expect(
    Arr.map(out, (event) => [
      event.type,
      event.content_block?.type ?? event.delta?.type,
    ])
  ).toEqual([
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
    Arr.join(
      Arr.flatMap(plain, (event) =>
        event.delta?.type === "text_delta" ? [event.delta.text] : []
      ),
      ""
    )
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
      content_block: { signature: "", thinking: "", type: "thinking" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { thinking: "hmm", type: "thinking_delta" },
      index: 0,
      type: "content_block_delta",
    },
    {
      delta: { signature: "sig-1", type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    },
    { index: 0, type: "content_block_stop" },
  ]);
});

// ---- why a reply stopped, and how it fails -----------------------------------------

test("Kiro's stop reason is said in Messages' words", async () => {
  const stopOf = async (stopReason: string) =>
    Option.getOrThrow(
      Arr.findFirst(
        await sse(
          await answer(HI, [said("x"), frame("metadataEvent", { stopReason })])
        ),
        (event) => event.type === "message_delta"
      )
    ).delta.stop_reason;
  expect(await stopOf("END_TURN")).toBe("end_turn");
  expect(await stopOf("MAX_TOKENS")).toBe("max_tokens");
  expect(await stopOf("CONTENT_FILTERED")).toBe("refusal");
});

test("a malformed event stream is a 502 before the reply, an error event after it began", async () => {
  // a message that says it is 8 bytes long, under the 16 any message takes
  const malformed = new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
  const message =
    "Kiro's reply broke off before it finished: its event stream was malformed";
  const before = await answer(HI, [malformed]);
  expect(before.status).toBe(502);
  expect(await errorOf(before)).toEqual({ message, type: "api_error" });
  const after = await sse(await answer(HI, [said("Half"), malformed]));
  expect(Arr.map(after, (event) => event.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ]);
  expect(after[4].error).toEqual({ message, type: "api_error" });
});

test("a 200 with no events in its body is a 502 OpenCode retries; one text event is a reply", async () => {
  const empty = await answer(HI, []);
  expect(empty.status).toBe(502);
  expect(await errorOf(empty)).toEqual({
    message: "Kiro ended its reply without sending anything",
    type: "api_error",
  });
  const one = await answer(HI, [said("Hi")]);
  expect(one.status).toBe(200);
  expect((await sse(one))[2].delta.text).toBe("Hi");
});

test("an error event Kiro sends among its events fails the reply as its kind says", async () => {
  const throttled = await answer(HI, [
    frame("throttlingError", { message: "slow down" }),
  ]);
  expect(throttled.status).toBe(429);
  expect(await errorOf(throttled)).toEqual({
    message: "Kiro is rate limiting requests. Kiro said: slow down",
    type: "rate_limit_error",
  });
  const out = await sse(
    await answer(HI, [
      said("Hi"),
      frame("internalServerException", { message: "boom" }),
    ])
  );
  expect(out.at(-1)).toEqual({
    error: {
      message:
        "Kiro had a server error. Kiro said: internalServerException: boom",
      type: "api_error",
    },
    type: "error",
  });
});

test("a reply that goes quiet is dropped as a stall, before its first event or after", async () => {
  const quietAfter = (...frames: Array<Uint8Array>) =>
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
  expect(await errorOf(before)).toEqual({ message, type: "api_error" });
  const after = await sse(await quietAfter(said("Hi")));
  expect(after[2].delta.text).toBe("Hi");
  expect(after.at(-1)).toEqual({
    error: { message, type: "api_error" },
    type: "error",
  });
});

// ---- the conversation Kiro is sent -------------------------------------------------

test("a mid-conversation system update is said as the user's; an effort-only one is dropped", () => {
  const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";
  const out = request(
    {
      messages: [
        { content: [{ type: "text", text: "hi" }], role: "user" },
        { content: [{ type: "text", text: "hello" }], role: "assistant" },
        { content: [], role: "system" },
        { content: [{ type: "text", text: "<reminder>" }], role: "system" },
        { content: [{ type: "text", text: "again" }], role: "user" },
      ],
      model: "claude-x",
      system: [{ text: "be brief", type: "text" }],
    },
    PROFILE
  );
  expect(out.conversationState.history?.[0]?.userInputMessage?.content).toBe(
    "be brief\n\nhi"
  );
  expect(out.conversationState.currentMessage.userInputMessage.content).toBe(
    "<reminder>\n\nagain"
  );
  expect(out.conversationState.currentMessage.userInputMessage.modelId).toBe(
    "claude-x"
  );
  expect(out.profileArn).toBe(PROFILE);
});

// One turn's parallel tool_use blocks split over two consecutive assistant
// messages, answered by one user message (yetone/magpie#1275, the request
// as Claude Code sent it).
const splitTurn = (answered = ["a", "b"]): Req => ({
  messages: [
    { content: "read a and b", role: "user" },
    {
      content: [
        { id: "toolu_a", input: { path: "a" }, name: "read", type: "tool_use" },
      ],
      role: "assistant",
    },
    {
      content: [
        { id: "toolu_b", input: { path: "b" }, name: "read", type: "tool_use" },
      ],
      role: "assistant",
    },
    {
      content: Arr.map(answered, (letter) => ({
        content: `${Str.toUpperCase(letter)}!`,
        tool_use_id: `toolu_${letter}`,
        type: "tool_result",
      })),
      role: "user",
    },
  ],
});

test("a turn's calls split over two assistant messages are answered by their real results", () => {
  const state = conversation(splitTurn());
  expect(
    Arr.map(
      state.history ?? [],
      (event) => Rec.keys<string, Entry[keyof Entry]>({ ...event })[0]
    )
  ).toEqual(["userInputMessage", "assistantResponseMessage"]);
  const uses = state.history?.[1]?.assistantResponseMessage?.toolUses ?? [];
  expect(Arr.map(uses, (call) => call.toolUseId)).toEqual([
    "toolu_a",
    "toolu_b",
  ]);
  expect(resultsOf(state)).toEqual(["toolu_a=A!", "toolu_b=B!"]);
  expect(JSON.stringify(state)).not.toContain(NO_RESULT);
});

test("a call of a split turn that went unanswered is still answered for", () => {
  expect(resultsOf(conversation(splitTurn(["b"])))).toEqual([
    "toolu_b=B!",
    `toolu_a=${NO_RESULT}`,
  ]);
});

test("a call id Kiro wouldn't take is sent as a hash of it, the same for the call and its result", () => {
  const state = conversation({
    messages: [
      { content: "go", role: "user" },
      {
        content: [{ id: "call 1/a", name: "read", type: "tool_use" }],
        role: "assistant",
      },
      {
        content: [
          { content: "ok", tool_use_id: "call 1/a", type: "tool_result" },
        ],
        role: "user",
      },
    ],
  });
  // t_ and the first 32 characters of the id's SHA-256, as base64url
  const id = "t_dKO8E588m5ssoqSCsb5R69khJ98LSORM";
  expect(
    state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId
  ).toBe(id);
  expect(resultsOf(state)).toEqual([`${id}=ok`]);
});

test("a tool's output past 250,000 characters is cut there", () => {
  const resultOf = (content: string) =>
    resultsOf(
      conversation({
        messages: [
          { content: "go", role: "user" },
          {
            content: [{ id: "t1", name: "read", type: "tool_use" }],
            role: "assistant",
          },
          {
            content: [{ content, tool_use_id: "t1", type: "tool_result" }],
            role: "user",
          },
        ],
      })
    )[0];
  const at = Str.repeat(250_000)("x");
  expect(resultOf(at)).toBe(`t1=${at}`);
  expect(resultOf(`${at}yz`)).toBe(`t1=${at}\n… (cut)`);
});

// Kiro's generateAssistantResponse has no field for the answer's format, so
// a request's structured output is told to the model in the system prompt.
const schema = {
  additionalProperties: false,
  properties: { answer: { type: "string" } },
  required: ["answer"],
  type: "object",
};
const told =
  'Respond with a single JSON value and nothing else, matching this JSON schema:\n{"additionalProperties":false,"properties":{"answer":{"type":"string"}},"required":["answer"],"type":"object"}.';

test("output_config.format's schema is told at the end of the system prompt", () => {
  const req: Req = {
    messages: [{ content: "hi", role: "user" }],
    output_config: { format: { schema, type: "json_schema" } },
    system: "Be brief.",
  };
  expect(opening(req)).toBe(`Be brief.\n\n${told}\n\nhi`);
});

test("with no system prompt the schema is the whole of it, after a thinking budget", () => {
  const req: Req = {
    messages: [{ content: "hi", role: "user" }],
    model: "claude-sonnet-4.5",
    output_config: { effort: "high", format: { schema, type: "json_schema" } },
  };
  expect(opening(req)).toBe(`${BUDGET(30_000)}\n${told}\n\nhi`);
  expect(
    opening({ ...req, output_config: { format: req.output_config!.format! } })
  ).toBe(`${told}\n\nhi`);
});

test("the AI SDK's output_format is told too", () => {
  const req: Req = {
    messages: [{ content: "hi", role: "user" }],
    output_format: { schema, type: "json_schema" },
    system: [{ text: "Be brief.", type: "text" }],
  };
  expect(opening(req)).toBe(`Be brief.\n\n${told}\n\nhi`);
});

test("a request with no format, or one with no schema, is sent without one", () => {
  for (const extra of [
    {},
    { output_config: { effort: "low" } },
    { output_config: { format: { type: "json_schema" } } },
    { output_config: { format: { type: "text" } } },
  ]) {
    const req: Req = {
      messages: [{ content: "hi", role: "user" }],
      model: "claude-x",
      system: "Be brief.",
      ...extra,
    };
    expect(opening(req)).toBe("Be brief.\n\nhi");
  }
});

// A tool's images reach the model (yetone/magpie#1861): Codex's view_image
// answers with a tool_result holding an image block. Kiro's tool results
// carry text alone, so the image goes with the message that answers the call.
test("a tool's image goes with the message that answers its call", () => {
  const input = conversation(viewImage([image(PNG)])).currentMessage
    .userInputMessage;
  expect(input.images).toEqual([{ format: "png", source: { bytes: PNG } }]);
  expect(input.userInputMessageContext?.toolResults).toEqual([
    {
      content: [{ text: "(no output)" }],
      status: "success",
      toolUseId: "call_view1",
    },
  ]);
});

test("a tool's text and images both go, every image in order", () => {
  const input = conversation(
    viewImage([
      { text: "Screenshot of Finder", type: "text" },
      image(PNG),
      image(JPG, "image/jpeg"),
    ])
  ).currentMessage.userInputMessage;
  expect(input.userInputMessageContext?.toolResults?.[0]?.content).toEqual([
    { text: "Screenshot of Finder" },
  ]);
  expect(Arr.map(input.images ?? [], (img) => img.format)).toEqual([
    "png",
    "jpeg",
  ]);
});

test("an image named only by a URL has no bytes to send and is left out", () => {
  const state = conversation(
    viewImage([{ source: { type: "url" }, type: "image" }])
  );
  expect(state.currentMessage.userInputMessage.images).toBeUndefined();
});

test("only the latest tool image is sent again, as Kiro's own agent sends only the latest", () => {
  const req = viewImage([image(PNG)]);
  req.messages.push(
    {
      content: [
        {
          id: "call_view2",
          input: { path: "/tmp/b.jpg" },
          name: "view_image",
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          content: [image(JPG, "image/jpeg")],
          tool_use_id: "call_view2",
          type: "tool_result",
        },
      ],
      role: "user",
    }
  );
  const state = conversation(req);
  expect(state.currentMessage.userInputMessage.images).toEqual([
    { format: "jpeg", source: { bytes: JPG } },
  ]);
  for (const event of state.history ?? []) {
    expect(event.userInputMessage?.images).toBeUndefined();
  }
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
    description: "Run a command",
    input_schema: {
      properties: { command: { type: "string" } },
      type: "object",
    },
    name: "Bash",
  };
  const state = conversation({
    messages: [
      {
        content: [
          {
            type: "text",
            text: "<system-reminder>\nAttribution …</system-reminder>",
          },
          { type: "text", text: "run echo hi" },
        ],
        role: "user",
      },
      { content: "# Environment\nYou have been invoked in …", role: "system" },
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            tool_use_id: "toolu_01",
            type: "tool_result",
            is_error: false,
            content: "hi",
          },
        ],
        role: "user",
      },
      {
        content: [
          {
            type: "text",
            text: "PreToolUse:Bash hook context: …",
            cache_control: EPH,
          },
        ],
        role: "system",
      },
    ],
    model: "claude-sonnet-4.5",
    system: [
      { text: "x-anthropic-billing-header: cc_version=2", type: "text" },
      { cache_control: EPH, text: "You are a Claude agent.", type: "text" },
      {
        cache_control: EPH,
        text: "You are an agent working with the user …",
        type: "text",
      },
    ],
    tools: [bash],
  });
  // the instructions are at the head of the first message, so its mark
  // covers them; the hook's context joins the tool result's message
  expect(state.history?.[0]?.userInputMessage?.cachePoint).toEqual(POINT);
  expect(
    state.history?.[1]?.assistantResponseMessage?.cachePoint
  ).toBeUndefined();
  expect(state.currentMessage.userInputMessage.cachePoint).toEqual(POINT);
  expect(toolsOf(state)).toEqual([
    {
      toolSpecification: {
        description: "Run a command",
        inputSchema: { json: bash.input_schema },
        name: "Bash",
      },
    },
  ]);
});

test("a marked tool is followed by a cachePoint, and marked messages get one each", () => {
  const state = conversation({
    messages: [
      {
        content: [{ type: "text", text: "hi", cache_control: EPH }],
        role: "user",
      },
      {
        content: [{ type: "text", text: "hello", cache_control: EPH }],
        role: "assistant",
      },
      { content: "and now?", role: "user" },
    ],
    system: "You are Codex.",
    tools: [
      { input_schema: EMPTY, name: "a" },
      { cache_control: EPH, input_schema: EMPTY, name: "b" },
    ],
  });
  expect(
    Arr.map(
      toolsOf(state),
      (tool) => Rec.keys<string, KiroTool[keyof KiroTool]>({ ...tool })[0]
    )
  ).toEqual(["toolSpecification", "toolSpecification", "cachePoint"]);
  expect(state.history?.[0]?.userInputMessage?.cachePoint).toEqual(POINT);
  expect(state.history?.[1]?.assistantResponseMessage?.cachePoint).toEqual(
    POINT
  );
  expect(state.currentMessage.userInputMessage.cachePoint).toBeUndefined();
});

test("nothing marked, no cachePoint sent", () => {
  const state = conversation({
    messages: [
      { content: "hi", role: "user" },
      { content: "yo", role: "assistant" },
      { content: "again", role: "user" },
    ],
  });
  expect(JSON.stringify(state)).not.toContain("cachePoint");
});

test("at most 4 cachePoints, the last ones kept", () => {
  const msgs: NonNullable<Req["messages"]> = [];
  for (let i = 0; i < 6; i++) {
    msgs.push(
      {
        content: [{ cache_control: EPH, text: `q${i}`, type: "text" }],
        role: "user",
      },
      { content: `a${i}`, role: "assistant" }
    );
  }
  msgs.push({
    content: [{ cache_control: EPH, text: "last", type: "text" }],
    role: "user",
  });
  const state = conversation({
    messages: msgs,
    tools: [{ cache_control: EPH, input_schema: EMPTY, name: "t" }],
  });
  expect([...Str.matchAll(/cachePoint/g)(JSON.stringify(state))]).toHaveLength(
    4
  );
  expect(state.currentMessage.userInputMessage.cachePoint).toEqual(POINT);
  expect(
    Arr.some(toolsOf(state), (tool) => tool.cachePoint !== undefined)
  ).toBe(false);
  expect(
    Arr.flatMap(state.history ?? [], (event) =>
      event.userInputMessage?.cachePoint ? [event.userInputMessage.content] : []
    )
  ).toEqual(["q3", "q4", "q5"]);
});

// ---- tool names --------------------------------------------------------------------

// Kiro refuses a tool named past 64 characters (REQUEST_BODY_INVALID).
// Claude Code names a plugin's MCP tools mcp__plugin_<plugin>_<server>__<tool>,
// which runs past it (yetone/magpie#1393, the reporter's names).
const LONG =
  "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation"; // 71
const LONG2 =
  "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide"; // 70
// LONG as Kiro is sent it: its head, and the first 12 hex digits of its SHA-256
const LONG_SENT =
  "mcp__plugin_cloudflare_cloudflare-docs__search_clou_44402c4dd80f";

const searched: Req = {
  messages: [
    { content: "search", role: "user" },
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: LONG,
          input: { q: "workers" },
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "found" },
      ],
      role: "user",
    },
  ],
  model: "claude-opus-4.5",
  tools: [
    { description: "Search Cloudflare docs", input_schema: EMPTY, name: LONG },
    { description: "Guide", input_schema: EMPTY, name: LONG2 },
    { description: "read", input_schema: EMPTY, name: "Read" },
    { description: "dotted", input_schema: EMPTY, name: "a.b" },
  ],
};

test("every tool name Kiro is sent is one it takes, the same each turn, and a short one is kept", () => {
  const state = conversation(searched);
  const names = Arr.map(
    toolsOf(state),
    (tool) => tool.toolSpecification?.name ?? ""
  );
  for (const name of names) {
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  }
  expect(names[0]).toBe(LONG_SENT);
  expect(names[1]).not.toBe(LONG_SENT);
  expect(names.slice(2)).toEqual(["Read", "a_b_2e7336dc8eba"]);
  // the call in the history names the tool as its declaration does
  expect(
    state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name
  ).toBe(LONG_SENT);
  expect(resultsOf(state)).toEqual(["toolu_1=found"]);
  // the next turn, opened afresh, names it the same way
  expect(toolsOf(conversation(searched))[0]?.toolSpecification?.name).toBe(
    LONG_SENT
  );
});

test("a call Kiro makes under a shortened name comes back under the caller's", async () => {
  const out = await sse(
    await answer(searched, [
      frame("toolUseEvent", { name: LONG_SENT, toolUseId: "t9" }),
    ])
  );
  expect(out[1].content_block).toEqual({
    id: "t9",
    input: {},
    name: LONG,
    type: "tool_use",
  });
  const delta = Option.getOrThrow(
    Arr.findFirst(out, (event) => event.type === "message_delta")
  );
  expect(delta.delta.stop_reason).toBe("tool_use");
});

test("a tool the conversation used and no longer offers is still declared, and its calls come back under its name", async () => {
  const req: Req = {
    messages: [
      { content: "go", role: "user" },
      {
        content: [{ id: "t1", name: "old.tool", type: "tool_use" }],
        role: "assistant",
      },
      {
        content: [{ content: "done", tool_use_id: "t1", type: "tool_result" }],
        role: "user",
      },
    ],
    tools: [{ description: "read", input_schema: EMPTY, name: "Read" }],
  };
  const state = conversation(req);
  expect(
    state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name
  ).toBe("old_tool_92563f344437");
  expect(toolsOf(state)).toEqual([
    {
      toolSpecification: {
        description: "read",
        inputSchema: { json: EMPTY },
        name: "Read",
      },
    },
    {
      toolSpecification: {
        description: "Tool",
        inputSchema: { json: EMPTY },
        name: "old_tool_92563f344437",
      },
    },
  ]);
  const out = await sse(
    await answer(req, [
      frame("toolUseEvent", { name: "old_tool_92563f344437", toolUseId: "t2" }),
    ])
  );
  expect(out[1].content_block.name).toBe("old.tool");
});
