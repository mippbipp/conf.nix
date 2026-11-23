// One turn of a conversation through src/conversation.ts's open: the Kiro
// request a Messages request becomes, and the Messages events Kiro's event
// stream comes back as.

import { assert, describe, it } from "@effect/vitest";
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
import { toJson } from "./json.ts";
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
  open(req, MODELS).answer(
    Stream.fromIterable(frames),
    () => Effect.void,
    idleSeconds
  );
// events is the reply's SSE events
const events = (req: Req, frames: Array<Uint8Array>) =>
  Effect.flatMap(answer(req, frames), sse);
const said = (content: string) => frame("assistantResponseEvent", { content });
const HI: Req = {
  messages: [{ content: "hi", role: "user" }],
  model: "claude-x",
};

// fieldsOf is the request fields Kiro is sent for HI to model, with extra
const fieldsOf = (model: string, extra: Partial<Req>) =>
  request({ ...HI, model, ...extra }).additionalModelRequestFields;

const BUDGET = (budget: number) =>
  `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;

// stopOf is the stop reason a reply that Kiro ended with stopReason gives
const stopOf = (stopReason: string) =>
  events(HI, [said("x"), frame("metadataEvent", { stopReason })]).pipe(
    Effect.map(
      (out) =>
        Option.getOrThrow(
          Arr.findFirst(out, (event) => event.type === "message_delta")
        ).delta?.stop_reason
    )
  );
// quietAfter is HI's reply, Kiro going quiet after frames
const quietAfter = (...frames: Array<Uint8Array>) =>
  open(HI, MODELS).answer(
    Stream.concat(Stream.fromIterable(frames), Stream.never),
    () => Effect.void,
    0.05
  );

// One turn's parallel tool_use blocks split over two consecutive assistant
// messages, answered by one user message (yetone/magpie#1275, the request
// as Claude Code sent it).
const splitTurn = (answered = ["a", "b"]): Req => ({
  messages: [
    { content: "read a and b", role: "user" },
    {
      content: [
        {
          id: "toolu_a",
          input: { path: "a" },
          name: "read",
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          id: "toolu_b",
          input: { path: "b" },
          name: "read",
          type: "tool_use",
        },
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

// resultOf is the result Kiro is sent for a tool's output of content
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

// Kiro takes Bedrock's cachePoint ({"type":"default"}) on a user message, on
// an assistant message and as an entry of the tools; the caller's
// cache_control marks become them.
const EPH = { type: "ephemeral" };
const POINT = { type: "default" } as const;

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
          id: "toolu_1",
          input: { q: "workers" },
          name: LONG,
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { content: "found", tool_use_id: "toolu_1", type: "tool_result" },
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

describe("a conversation turn", () => {
  it.effect(
    "a model Kiro lists thinking fields for is sent them, from the variant's effort",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          fieldsOf("claude-x", {
            max_tokens: 99_999,
            output_config: { effort: "high" },
          }),
          {
            max_tokens: 64_000,
            output_config: { effort: "high" },
            thinking: { display: "summarized", type: "adaptive" },
          }
        );
        assert.deepStrictEqual(
          fieldsOf("claude-x", { output_config: { effort: "none" } }),
          {
            thinking: { type: "disabled" },
          }
        );
        assert.deepStrictEqual(
          fieldsOf("gpt-x", { output_config: { effort: "low" } }),
          {
            reasoning: { effort: "low" },
          }
        );
        assert.isUndefined(fieldsOf("claude-x", {}));
        // fields go instead of a budget in the prompt
        assert.strictEqual(
          opening({ ...HI, output_config: { effort: "high" } }),
          "hi"
        );
      })
  );

  it.effect(
    "max_tokens is sent to a model that takes it, within its limits, with or without an effort",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(fieldsOf("claude-x", { max_tokens: 2000 }), {
          max_tokens: 2000,
        });
        assert.deepStrictEqual(fieldsOf("claude-x", { max_tokens: 500 }), {
          max_tokens: 1024,
        });
        assert.deepStrictEqual(fieldsOf("claude-x", { max_tokens: 99_999 }), {
          max_tokens: 64_000,
        });
        // gpt-x lists no max_tokens field
        assert.isUndefined(fieldsOf("gpt-x", { max_tokens: 2000 }));
      })
  );

  it.effect(
    "a model Kiro lists no fields for is told a thinking budget in the prompt",
    () =>
      Effect.sync(() => {
        const old = (extra: Partial<Req>) => ({
          ...HI,
          model: "claude-sonnet-4.5",
          ...extra,
        });
        assert.strictEqual(
          opening(old({ output_config: { effort: "medium" } })),
          `${BUDGET(20_000)}\n\nhi`
        );
        // Claude Code's xhigh isn't routed as max (magpie #120)
        assert.strictEqual(
          opening(old({ output_config: { effort: "xhigh" } })),
          `${BUDGET(50_000)}\n\nhi`
        );
        assert.strictEqual(
          opening(
            old({ thinking: { budget_tokens: 12_345, type: "enabled" } })
          ),
          `${BUDGET(12_345)}\n\nhi`
        );
        assert.isUndefined(
          request(old({ output_config: { effort: "medium" } }))
            .additionalModelRequestFields
        );
        // a model that doesn't think is told nothing
        assert.strictEqual(
          opening({
            ...HI,
            model: "deepseek-3.2",
            output_config: { effort: "high" },
          }),
          "hi"
        );
      })
  );

  it.effect(
    "a reply to a thinking budget has its <thinking> split off as thinking, however the tags fall",
    () =>
      Effect.gen(function* () {
        const budgeted: Req = {
          ...HI,
          model: "claude-sonnet-4.5",
          output_config: { effort: "high" },
        };
        const pieces = Arr.map(
          ["<think", "ing>\nI should", " look.</thi", "nking>\n\nHello"],
          (piece) => said(piece)
        );
        const out = yield* events(budgeted, pieces);
        assert.deepStrictEqual(
          Arr.map(out, (event) => [
            event.type,
            event.content_block?.type ?? event.delta?.type,
          ]),
          [
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
          ]
        );
        assert.strictEqual(
          String(out[2]?.delta?.thinking) + String(out[3]?.delta?.thinking),
          "I should look."
        );
        assert.strictEqual(out[6]?.delta?.text, "Hello");
        // without a budget the same reply is text, tags and all
        const plain = yield* events(HI, pieces);
        assert.strictEqual(
          Arr.join(
            Arr.flatMap(plain, (event) =>
              event.delta?.type === "text_delta"
                ? [String(event.delta.text)]
                : []
            ),
            ""
          ),
          "<thinking>\nI should look.</thinking>\n\nHello"
        );
      })
  );

  it.effect("a reasoning signature goes on the thinking block it follows", () =>
    Effect.gen(function* () {
      const out = yield* events(HI, [
        frame("reasoningContentEvent", { text: "hmm" }),
        frame("reasoningContentEvent", { signature: "sig-1" }),
        said("ok"),
      ]);
      assert.deepStrictEqual(out.slice(1, 5), [
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
    })
  );

  it.effect("Kiro's stop reason is said in Messages' words", () =>
    Effect.gen(function* () {
      const stop = yield* stopOf("END_TURN");
      assert.strictEqual(stop, "end_turn");
      const stop2 = yield* stopOf("MAX_TOKENS");
      assert.strictEqual(stop2, "max_tokens");
      const stop3 = yield* stopOf("CONTENT_FILTERED");
      assert.strictEqual(stop3, "refusal");
    })
  );

  it.effect(
    "a malformed event stream is a 502 before the reply, an error event after it began",
    () =>
      Effect.gen(function* () {
        // a message that says it is 8 bytes long, under the 16 any message takes
        const malformed = new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
        const message =
          "Kiro's reply broke off before it finished: its event stream was malformed";
        const before = yield* answer(HI, [malformed]);
        assert.strictEqual(before.status, 502);
        const error = yield* errorOf(before);
        assert.deepStrictEqual(error, {
          message,
          type: "api_error",
        });
        const after = yield* events(HI, [said("Half"), malformed]);
        assert.deepStrictEqual(
          Arr.map(after, (event) => event.type),
          [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "error",
          ]
        );
        assert.deepStrictEqual(after[4]?.error, { message, type: "api_error" });
      })
  );

  it.effect(
    "a 200 with no events in its body is a 502 OpenCode retries; one text event is a reply",
    () =>
      Effect.gen(function* () {
        const empty = yield* answer(HI, []);
        assert.strictEqual(empty.status, 502);
        const error = yield* errorOf(empty);
        assert.deepStrictEqual(error, {
          message: "Kiro ended its reply without sending anything",
          type: "api_error",
        });
        const one = yield* answer(HI, [said("Hi")]);
        assert.strictEqual(one.status, 200);
        const out = yield* sse(one);
        assert.strictEqual(out[2]?.delta?.text, "Hi");
      })
  );

  it.effect(
    "an error event Kiro sends among its events fails the reply as its kind says",
    () =>
      Effect.gen(function* () {
        const throttled = yield* answer(HI, [
          frame("throttlingError", { message: "slow down" }),
        ]);
        assert.strictEqual(throttled.status, 429);
        const error = yield* errorOf(throttled);
        assert.deepStrictEqual(error, {
          message: "Kiro is rate limiting requests. Kiro said: slow down",
          type: "rate_limit_error",
        });
        const out = yield* events(HI, [
          said("Hi"),
          frame("internalServerException", { message: "boom" }),
        ]);
        assert.deepStrictEqual(out.at(-1), {
          error: {
            message:
              "Kiro had a server error. Kiro said: internalServerException: boom",
            type: "api_error",
          },
          type: "error",
        });
      })
  );

  it.live(
    "a reply that goes quiet is dropped as a stall, before its first event or after",
    () =>
      Effect.gen(function* () {
        const message =
          "Kiro stopped responding: nothing arrived for 0.05 seconds, so the reply was dropped";
        const before = yield* quietAfter();
        assert.strictEqual(before.status, 504);
        const error = yield* errorOf(before);
        assert.deepStrictEqual(error, {
          message,
          type: "api_error",
        });
        const after = yield* Effect.flatMap(quietAfter(said("Hi")), sse);
        assert.strictEqual(after[2]?.delta?.text, "Hi");
        assert.deepStrictEqual(after.at(-1), {
          error: { message, type: "api_error" },
          type: "error",
        });
      })
  );

  it.effect(
    "a mid-conversation system update is said as the user's; an effort-only one is dropped",
    () =>
      Effect.sync(() => {
        const PROFILE =
          "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";
        const out = request(
          {
            messages: [
              { content: [{ text: "hi", type: "text" }], role: "user" },
              { content: [{ text: "hello", type: "text" }], role: "assistant" },
              { content: [], role: "system" },
              {
                content: [{ text: "<reminder>", type: "text" }],
                role: "system",
              },
              { content: [{ text: "again", type: "text" }], role: "user" },
            ],
            model: "claude-x",
            system: [{ text: "be brief", type: "text" }],
          },
          PROFILE
        );
        assert.strictEqual(
          out.conversationState.history?.[0]?.userInputMessage?.content,
          "be brief\n\nhi"
        );
        assert.strictEqual(
          out.conversationState.currentMessage.userInputMessage.content,
          "<reminder>\n\nagain"
        );
        assert.strictEqual(
          out.conversationState.currentMessage.userInputMessage.modelId,
          "claude-x"
        );
        assert.strictEqual(out.profileArn, PROFILE);
      })
  );

  it.effect(
    "a turn's calls split over two assistant messages are answered by their real results",
    () =>
      Effect.sync(() => {
        const state = conversation(splitTurn());
        assert.deepStrictEqual(
          Arr.map(
            state.history ?? [],
            (event) => Rec.keys<string, Entry[keyof Entry]>({ ...event })[0]
          ),
          ["userInputMessage", "assistantResponseMessage"]
        );
        const uses =
          state.history?.[1]?.assistantResponseMessage?.toolUses ?? [];
        assert.deepStrictEqual(
          Arr.map(uses, (call) => call.toolUseId),
          ["toolu_a", "toolu_b"]
        );
        assert.deepStrictEqual(resultsOf(state), ["toolu_a=A!", "toolu_b=B!"]);
        assert.notInclude(toJson(state), NO_RESULT);
      })
  );

  it.effect(
    "a call of a split turn that went unanswered is still answered for",
    () =>
      Effect.sync(() => {
        const state = conversation(splitTurn(["b"]));
        assert.deepStrictEqual(resultsOf(state), [
          "toolu_b=B!",
          `toolu_a=${NO_RESULT}`,
        ]);
      })
  );

  it.effect(
    "a call id Kiro wouldn't take is sent as a hash of it, the same for the call and its result",
    () =>
      Effect.sync(() => {
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
        assert.strictEqual(
          state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]
            ?.toolUseId,
          id
        );
        assert.deepStrictEqual(resultsOf(state), [`${id}=ok`]);
      })
  );

  it.effect("a tool's output past 250,000 characters is cut there", () =>
    Effect.sync(() => {
      const at = Str.repeat(250_000)("x");
      assert.strictEqual(resultOf(at), `t1=${at}`);
      assert.strictEqual(resultOf(`${at}yz`), `t1=${at}\n… (cut)`);
    })
  );

  it.effect(
    "output_config.format's schema is told at the end of the system prompt",
    () =>
      Effect.sync(() => {
        const req: Req = {
          messages: [{ content: "hi", role: "user" }],
          output_config: { format: { schema, type: "json_schema" } },
          system: "Be brief.",
        };
        assert.strictEqual(opening(req), `Be brief.\n\n${told}\n\nhi`);
      })
  );

  it.effect(
    "with no system prompt the schema is the whole of it, after a thinking budget",
    () =>
      Effect.sync(() => {
        const format = { schema, type: "json_schema" };
        const req: Req = {
          messages: [{ content: "hi", role: "user" }],
          model: "claude-sonnet-4.5",
          output_config: { effort: "high", format },
        };
        assert.strictEqual(opening(req), `${BUDGET(30_000)}\n${told}\n\nhi`);
        assert.strictEqual(
          opening({
            ...req,
            output_config: { format },
          }),
          `${told}\n\nhi`
        );
      })
  );

  it.effect("the AI SDK's output_format is told too", () =>
    Effect.sync(() => {
      const req: Req = {
        messages: [{ content: "hi", role: "user" }],
        output_format: { schema, type: "json_schema" },
        system: [{ text: "Be brief.", type: "text" }],
      };
      assert.strictEqual(opening(req), `Be brief.\n\n${told}\n\nhi`);
    })
  );

  it.effect(
    "a request with no format, or one with no schema, is sent without one",
    () =>
      Effect.sync(() => {
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
          assert.strictEqual(opening(req), "Be brief.\n\nhi");
        }
      })
  );

  // A tool's images reach the model (yetone/magpie#1861): Codex's view_image
  // answers with a tool_result holding an image block. Kiro's tool results
  // carry text alone, so the image goes with the message that answers the call.
  it.effect("a tool's image goes with the message that answers its call", () =>
    Effect.sync(() => {
      const input = conversation(viewImage([image(PNG)])).currentMessage
        .userInputMessage;
      assert.deepStrictEqual(input.images, [
        { format: "png", source: { bytes: PNG } },
      ]);
      assert.deepStrictEqual(input.userInputMessageContext?.toolResults, [
        {
          content: [{ text: "(no output)" }],
          status: "success",
          toolUseId: "call_view1",
        },
      ]);
    })
  );

  it.effect("a tool's text and images both go, every image in order", () =>
    Effect.sync(() => {
      const input = conversation(
        viewImage([
          { text: "Screenshot of Finder", type: "text" },
          image(PNG),
          image(JPG, "image/jpeg"),
        ])
      ).currentMessage.userInputMessage;
      assert.deepStrictEqual(
        input.userInputMessageContext?.toolResults?.[0]?.content,
        [{ text: "Screenshot of Finder" }]
      );
      assert.deepStrictEqual(
        Arr.map(input.images ?? [], (img) => img.format),
        ["png", "jpeg"]
      );
    })
  );

  it.effect(
    "an image named only by a URL has no bytes to send and is left out",
    () =>
      Effect.sync(() => {
        const state = conversation(
          viewImage([{ source: { type: "url" }, type: "image" }])
        );
        assert.isUndefined(state.currentMessage.userInputMessage.images);
      })
  );

  it.effect(
    "only the latest tool image is sent again, as Kiro's own agent sends only the latest",
    () =>
      Effect.sync(() => {
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
        assert.deepStrictEqual(state.currentMessage.userInputMessage.images, [
          { format: "jpeg", source: { bytes: JPG } },
        ]);
        for (const event of state.history ?? []) {
          assert.isUndefined(event.userInputMessage?.images);
        }
      })
  );

  it.effect("Claude Code's cache marks go on the messages they end up in", () =>
    Effect.sync(() => {
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
                text: "<system-reminder>\nAttribution …</system-reminder>",
                type: "text",
              },
              { text: "run echo hi", type: "text" },
            ],
            role: "user",
          },
          {
            content: "# Environment\nYou have been invoked in …",
            role: "system",
          },
          {
            content: [
              {
                id: "toolu_01",
                input: { command: "echo hi" },
                name: "Bash",
                type: "tool_use",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                content: "hi",
                is_error: false,
                tool_use_id: "toolu_01",
                type: "tool_result",
              },
            ],
            role: "user",
          },
          {
            content: [
              {
                cache_control: EPH,
                text: "PreToolUse:Bash hook context: …",
                type: "text",
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
      assert.deepStrictEqual(
        state.history?.[0]?.userInputMessage?.cachePoint,
        POINT
      );
      assert.isUndefined(
        state.history?.[1]?.assistantResponseMessage?.cachePoint
      );
      assert.deepStrictEqual(
        state.currentMessage.userInputMessage.cachePoint,
        POINT
      );
      assert.deepStrictEqual(toolsOf(state), [
        {
          toolSpecification: {
            description: "Run a command",
            inputSchema: { json: bash.input_schema },
            name: "Bash",
          },
        },
      ]);
    })
  );

  it.effect(
    "a marked tool is followed by a cachePoint, and marked messages get one each",
    () =>
      Effect.sync(() => {
        const state = conversation({
          messages: [
            {
              content: [{ cache_control: EPH, text: "hi", type: "text" }],
              role: "user",
            },
            {
              content: [{ cache_control: EPH, text: "hello", type: "text" }],
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
        assert.deepStrictEqual(
          Arr.map(
            toolsOf(state),
            (tool) => Rec.keys<string, KiroTool[keyof KiroTool]>({ ...tool })[0]
          ),
          ["toolSpecification", "toolSpecification", "cachePoint"]
        );
        assert.deepStrictEqual(
          state.history?.[0]?.userInputMessage?.cachePoint,
          POINT
        );
        assert.deepStrictEqual(
          state.history?.[1]?.assistantResponseMessage?.cachePoint,
          POINT
        );
        assert.isUndefined(state.currentMessage.userInputMessage.cachePoint);
      })
  );

  it.effect("nothing marked, no cachePoint sent", () =>
    Effect.sync(() => {
      const state = conversation({
        messages: [
          { content: "hi", role: "user" },
          { content: "yo", role: "assistant" },
          { content: "again", role: "user" },
        ],
      });
      assert.notInclude(toJson(state), "cachePoint");
    })
  );

  it.effect("at most 4 cachePoints, the last ones kept", () =>
    Effect.sync(() => {
      const msgs: NonNullable<Req["messages"]> = [];
      for (let i = 0; i < 6; i += 1) {
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
      assert.lengthOf([...Str.matchAll(/cachePoint/gu)(toJson(state))], 4);
      assert.deepStrictEqual(
        state.currentMessage.userInputMessage.cachePoint,
        POINT
      );
      assert.isFalse(
        Arr.some(toolsOf(state), (tool) => tool.cachePoint !== undefined)
      );
      assert.deepStrictEqual(
        Arr.flatMap(state.history ?? [], (event) =>
          event.userInputMessage?.cachePoint === undefined
            ? []
            : [event.userInputMessage.content]
        ),
        ["q3", "q4", "q5"]
      );
    })
  );

  it.effect(
    "every tool name Kiro is sent is one it takes, the same each turn, and a short one is kept",
    () =>
      Effect.sync(() => {
        const state = conversation(searched);
        const names = Arr.map(
          toolsOf(state),
          (tool) => tool.toolSpecification?.name ?? ""
        );
        for (const name of names) {
          assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/u);
        }
        assert.strictEqual(names[0], LONG_SENT);
        assert.notStrictEqual(names[1], LONG_SENT);
        assert.deepStrictEqual(names.slice(2), ["Read", "a_b_2e7336dc8eba"]);
        // the call in the history names the tool as its declaration does
        assert.strictEqual(
          state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name,
          LONG_SENT
        );
        assert.deepStrictEqual(resultsOf(state), ["toolu_1=found"]);
        // the next turn, opened afresh, names it the same way
        assert.strictEqual(
          toolsOf(conversation(searched))[0]?.toolSpecification?.name,
          LONG_SENT
        );
      })
  );

  it.effect(
    "a call Kiro makes under a shortened name comes back under the caller's",
    () =>
      Effect.gen(function* () {
        const out = yield* events(searched, [
          frame("toolUseEvent", { name: LONG_SENT, toolUseId: "t9" }),
        ]);
        assert.deepStrictEqual(out[1]?.content_block, {
          id: "t9",
          input: {},
          name: LONG,
          type: "tool_use",
        });
        const delta = Option.getOrThrow(
          Arr.findFirst(out, (event) => event.type === "message_delta")
        );
        assert.strictEqual(delta.delta?.stop_reason, "tool_use");
      })
  );

  it.effect(
    "a tool the conversation used and no longer offers is still declared, and its calls come back under its name",
    () =>
      Effect.gen(function* () {
        const req: Req = {
          messages: [
            { content: "go", role: "user" },
            {
              content: [{ id: "t1", name: "old.tool", type: "tool_use" }],
              role: "assistant",
            },
            {
              content: [
                { content: "done", tool_use_id: "t1", type: "tool_result" },
              ],
              role: "user",
            },
          ],
          tools: [{ description: "read", input_schema: EMPTY, name: "Read" }],
        };
        const state = conversation(req);
        assert.strictEqual(
          state.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.name,
          "old_tool_92563f344437"
        );
        assert.deepStrictEqual(toolsOf(state), [
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
        const out = yield* events(req, [
          frame("toolUseEvent", {
            name: "old_tool_92563f344437",
            toolUseId: "t2",
          }),
        ]);
        assert.strictEqual(out[1]?.content_block?.name, "old.tool");
      })
  );
});
