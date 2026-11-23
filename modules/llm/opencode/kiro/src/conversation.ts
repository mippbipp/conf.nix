// One turn of a conversation with Kiro, translated both ways. The Anthropic
// Messages request OpenCode sends becomes the conversation Kiro's
// generateAssistantResponse takes, and the AWS event stream Kiro answers
// with becomes Messages' SSE events. What a turn decides once, open decides:
// how the model is asked to think (request fields, or a budget told in the
// prompt that the reply's <thinking> tags then answer) and the names Kiro
// is sent tools under, which the reply maps back.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  Array as Arr,
  Cause,
  Effect,
  Exit,
  Option,
  Predicate,
  Record as Rec,
  Schema,
  Scope,
  Sink,
  Stream,
  String as Str,
} from "effect";

import {
  type Failure,
  brokeOff,
  emptyReply,
  fromBody,
  fromException,
  toError,
  toResponse,
} from "./failure.ts";
import { field, IDLE_SECONDS, isSet } from "./kiro.ts";
import { BUDGETS, type KiroModel, thinks } from "./models.ts";

// ---- the request: Messages → a Kiro conversation ---------------------------------------

// The parts of an Anthropic Messages request the plugin reads. OpenCode's
// own Anthropic route writes it, so it is taken to be of this shape, and
// every field is still read as if it might be missing.
interface Block {
  cache_control?: unknown;
  content?: string | Array<Block>;
  id?: string;
  input?: unknown;
  is_error?: boolean;
  name?: string;
  source?: {
    content?: string | Array<Block>;
    data?: string;
    media_type?: string;
    type?: string;
  };
  text?: string;
  title?: string;
  tool_use_id?: string;
  type?: string;
}
interface Message {
  content?: string | Array<Block>;
  role?: string;
}
interface Tool {
  cache_control?: unknown;
  description?: string;
  input_schema?: unknown;
  name?: string;
  type?: string;
}
interface OutputFormat {
  schema?: unknown;
  type?: string;
}
export interface MessagesRequest {
  max_tokens?: number;
  messages?: Array<Message>;
  model?: string;
  output_config?: { effort?: string; format?: OutputFormat };
  output_format?: OutputFormat;
  stream?: boolean;
  system?: string | Array<Block>;
  thinking?: { budget_tokens?: number; type?: string };
  tools?: Array<Tool>;
}

// A Kiro conversation, as generateAssistantResponse takes it.
interface KiroImage {
  format: string;
  source: { bytes: string };
}
interface ToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
interface CachePoint {
  type: "default";
}
type KiroTool =
  | {
      cachePoint?: never;
      toolSpecification: {
        description: string;
        inputSchema: { json: unknown };
        name: string;
      };
    }
  | { cachePoint: CachePoint; toolSpecification?: never };
interface UserInput {
  cachePoint?: CachePoint;
  content: string;
  images?: Array<KiroImage>;
  modelId: string;
  origin: "KIRO_CLI";
  userInputMessageContext?: {
    toolResults?: Array<ToolResult>;
    tools?: Array<KiroTool>;
  };
}
interface ToolUse {
  input: object;
  name: string;
  toolUseId: string;
}
interface AssistantResponse {
  cachePoint?: CachePoint;
  content: string;
  toolUses?: Array<ToolUse>;
}
interface Entry {
  assistantResponseMessage?: AssistantResponse;
  userInputMessage?: UserInput;
}
// the thinking fields Kiro passes on to the model
// a type alias, so it is assignable to the Record Rec.isEmptyRecord takes
// oxlint-disable-next-line typescript/consistent-type-definitions
type Fields = {
  max_tokens?: number;
  output_config?: { effort: string };
  reasoning?: { effort: string };
  thinking?: { display?: "summarized"; type: "adaptive" | "disabled" };
};
export interface KiroRequest {
  additionalModelRequestFields?: Fields;
  agentMode: "vibe";
  conversationState: {
    agentTaskType: "vibe";
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: { userInputMessage: UserInput };
    history?: Array<Entry>;
  };
  profileArn?: string;
}

const PROCEED = "Please proceed with the task."; // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const RESULT_LIMIT = 250_000; // a tool's output is cut at this, as Kiro's own agent cuts it
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/u;

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
const toolID = (id: string | undefined) =>
  id !== undefined && id !== "" && TOOL_ID.test(id)
    ? id
    : `t_${Str.slice(
        0,
        32
      )(
        createHash("sha256")
          .update(id ?? "")
          .digest("base64url")
      )}`;

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), and
// MCP tool names can run longer.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so later turns name it the
// same way. toolNames maps each such name back.
const toolName = (given = "") => {
  if (TOOL_NAME.test(given)) {
    return given;
  }
  const hash = Str.slice(
    0,
    12
  )(createHash("sha256").update(given).digest("hex"));
  const head = Str.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")(given);
  return `${Str.slice(0, 64 - 1 - hash.length)(head)}_${hash}`;
};

// toolNames is the name the caller knows for each tool a request names that
// Kiro is sent under another name.
function toolNames(req: MessagesRequest) {
  const names = new Map<string, string>();
  const add = (name: string | undefined) => {
    if (!Predicate.isString(name) || name === "") {
      return;
    }
    const sentAs = toolName(name);
    if (sentAs !== name) {
      names.set(sentAs, name);
    }
  };
  for (const tool of req.tools ?? []) {
    add(tool?.name);
  }
  for (const message of req.messages ?? []) {
    if (Arr.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_use") {
          add(block.name);
        }
      }
    }
  }
  return names;
}

function imageFormat(mediaType: string | undefined) {
  const lower = Str.toLowerCase(mediaType ?? "");
  const format = Str.replace(/^image\//u, "")(lower);
  if (format === "jpg") {
    return "jpeg";
  }
  if (format === "" || format === lower) {
    return "png";
  }
  return format;
}

// addImage puts an Anthropic image block in images as Kiro takes it, the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images: Array<KiroImage>, block: Block) {
  if (
    block.source?.type === "base64" &&
    block.source.data !== undefined &&
    block.source.data !== ""
  ) {
    images.push({
      format: imageFormat(block.source.media_type),
      source: { bytes: block.source.data },
    });
  }
}
const addImages = (images: Array<KiroImage>, blocks: Array<Block>) => {
  for (const block of blocks) {
    if (block?.type === "image") {
      addImage(images, block);
    }
  }
};

const textOf = (content: string | Array<Block> | undefined): string =>
  Predicate.isString(content)
    ? content
    : Arr.isArray(content)
      ? Arr.join(
          Arr.flatMap(content, (block) =>
            block?.type === "text" ? [block.text ?? ""] : []
          ),
          "\n\n"
        )
      : "";
const joinNonEmpty = (head: string, tail: string) =>
  head !== "" && tail !== "" ? `${head}\n\n${tail}` : head + tail;

function documentText(block: Block) {
  const title =
    block.title === undefined || block.title === "" ? "" : `${block.title}\n`;
  if (block.source?.type === "text") {
    return title + (block.source.data ?? "");
  }
  if (block.source?.type === "content") {
    return title + textOf(block.source.content);
  }
  return `${title}[a ${block.source?.media_type ?? "document"} attachment]`;
}

// Thinking is how the model is asked to think: request fields, or a budget
// told in the prompt.
interface Thinking {
  budget?: number;
  fields?: Fields;
}

// effortFields is the thinking fields Kiro lists for kiroModel, set for effort
function effortFields(kiroModel: KiroModel, effort: string): Fields {
  const fields: Fields = {};
  if (kiroModel.fields === "openai") {
    if (kiroModel.efforts.includes(effort)) {
      fields.reasoning = { effort };
    }
  } else if (effort === "none") {
    if (kiroModel.off === true) {
      fields.thinking = { type: "disabled" };
    }
  } else if (kiroModel.efforts.includes(effort)) {
    fields.thinking =
      kiroModel.summarized === true
        ? { display: "summarized", type: "adaptive" }
        : { type: "adaptive" };
    fields.output_config = { effort };
  }
  return fields;
}

// thinkingFields is the request fields Kiro lists for kiroModel: the
// thinking ones for effort, when the request has one, and the request's
// max_tokens, within the model's limits
function thinkingFields(
  req: MessagesRequest,
  kiroModel: KiroModel,
  effort: string | undefined
): Fields {
  const fields =
    effort === undefined || effort === ""
      ? {}
      : effortFields(kiroModel, effort);
  const limits = kiroModel.maxTokens;
  if (
    limits !== undefined &&
    req.max_tokens !== undefined &&
    req.max_tokens > 0
  ) {
    fields.max_tokens = Math.min(
      Math.max(req.max_tokens, limits[0]),
      limits[1]
    );
  }
  return fields;
}

// thinkingOf is how the model is asked to think, from the effort the
// variant set (output_config.effort): the request fields Kiro lists for the
// model (kiroModel), or, for a model it lists none for, a thinking budget
// for the prompt.
function thinkingOf(
  req: MessagesRequest,
  model: string,
  kiroModel: KiroModel | undefined
): Thinking {
  const effort = req.output_config?.effort;
  if (kiroModel !== undefined && kiroModel.fields !== "") {
    const fields = thinkingFields(req, kiroModel, effort);
    return Rec.isEmptyRecord<string, unknown>(fields) ? {} : { fields };
  }
  if (!thinks(model)) {
    return {};
  }
  if (
    req.thinking?.type === "enabled" &&
    req.thinking.budget_tokens !== undefined &&
    req.thinking.budget_tokens > 0
  ) {
    return { budget: req.thinking.budget_tokens };
  }
  const budget =
    effort === undefined || effort === "" ? undefined : BUDGETS.get(effort);
  return budget === undefined || !isSet(budget) ? {} : { budget };
}

// formatText is the structured output a request asks for, said in words:
// output_config.format with a JSON schema, "" when it asks for none.
function formatText(req: MessagesRequest) {
  const format = req.output_config?.format ?? req.output_format;
  if (
    format?.type !== "json_schema" ||
    !Predicate.isObjectOrArray(format.schema)
  ) {
    return "";
  }
  // oxlint-disable-next-line effecttsgo/global-json -- the schema was parsed from the request's JSON body, so stringify cannot throw
  const schema = JSON.stringify(format.schema);
  return `Respond with a single JSON value and nothing else, matching this JSON schema:\n${schema}.`;
}

type KiroMessage = UserInput | AssistantResponse;

// the messages the caller marked for its prompt cache (cache_control),
// which go to Kiro as a cachePoint on the message they end up in
type Marked = WeakSet<KiroMessage>;
function mark(marked: Marked, message: KiroMessage, blocks: Array<Block>) {
  if (Arr.some(blocks, (block) => Boolean(block?.cache_control))) {
    marked.add(message);
  }
}

const blocksOf = (message: Message): Array<Block> =>
  Predicate.isString(message.content)
    ? [{ text: message.content, type: "text" }]
    : (message.content ?? []);

// assistantResponse is an assistant message as Kiro takes it: its text and
// its tool calls
function assistantResponse(blocks: Array<Block>): AssistantResponse {
  const texts: Array<string> = [];
  const uses: Array<ToolUse> = [];
  for (const block of blocks) {
    if (
      block?.type === "text" &&
      block.text !== undefined &&
      block.text !== ""
    ) {
      texts.push(block.text);
    } else if (block?.type === "tool_use") {
      const input = Predicate.isObject(block.input) ? block.input : {};
      uses.push({
        input,
        name: toolName(block.name),
        toolUseId: toolID(block.id),
      });
    }
  }
  return { content: Arr.join(texts, "\n\n"), toolUses: uses };
}

function toolResult(block: Block): ToolResult {
  let out = textOf(block.content);
  if (out.length > RESULT_LIMIT) {
    out = `${Str.slice(0, RESULT_LIMIT)(out)}\n… (cut)`;
  }
  return {
    content: [{ text: out === "" ? "(no output)" : out }],
    status: block.is_error === true ? "error" : "success",
    toolUseId: toolID(block.tool_use_id),
  };
}

// userInput is a user message as Kiro takes it: its text, its images and
// its tool results
function userInput(blocks: Array<Block>, model: string): UserInput {
  const texts: Array<string> = [];
  const images: Array<KiroImage> = [];
  const results: Array<ToolResult> = [];
  for (const block of blocks) {
    if (block?.type === "text") {
      if (block.text !== undefined && block.text !== "") {
        texts.push(block.text);
      }
    } else if (block?.type === "document") {
      texts.push(documentText(block));
    } else if (block?.type === "image") {
      addImage(images, block);
    } else if (block?.type === "tool_result") {
      results.push(toolResult(block));
      // a tool's images (a screenshot) go with the message, as Kiro's tool
      // results carry text alone
      if (Arr.isArray(block.content)) {
        addImages(images, block.content);
      }
    }
  }
  const input: UserInput = {
    content: Arr.join(texts, "\n\n"),
    images,
    modelId: model,
    origin: "KIRO_CLI",
  };
  if (results.length > 0) {
    input.userInputMessageContext = { toolResults: results };
  }
  return input;
}

// addAssistant adds response to entries, joined to the message before it
// when that is the assistant's too. It is the message response ends up in.
function addAssistant(
  entries: Array<Entry>,
  response: AssistantResponse
): AssistantResponse {
  const prev = entries.at(-1)?.assistantResponseMessage;
  if (prev === undefined) {
    entries.push({ assistantResponseMessage: response });
    return response;
  }
  prev.content = joinNonEmpty(prev.content, response.content);
  (prev.toolUses ??= []).push(...(response.toolUses ?? []));
  return prev;
}

// addUser adds input to entries, joined to the message before it when that
// is the user's too. It is the message input ends up in.
function addUser(entries: Array<Entry>, input: UserInput): UserInput {
  const prev = entries.at(-1)?.userInputMessage;
  if (prev === undefined) {
    entries.push({ userInputMessage: input });
    return input;
  }
  prev.content = joinNonEmpty(prev.content, input.content);
  (prev.images ??= []).push(...(input.images ?? []));
  const results = input.userInputMessageContext?.toolResults ?? [];
  if (results.length > 0) {
    ((prev.userInputMessageContext ??= {}).toolResults ??= []).push(...results);
  }
  return prev;
}

// entriesOf is the request's messages as Kiro's conversation, each joined
// to the one before it when both are the same role's
function entriesOf(
  req: MessagesRequest,
  model: string,
  marked: Marked
): Array<Entry> {
  const entries: Array<Entry> = [];
  for (const message of req.messages ?? []) {
    const blocks = blocksOf(message);
    // Kiro has no system role mid-conversation: an update's text is said as
    // the user's, and one with no text (an effort change) is dropped
    const dropped =
      message.role === "system" &&
      !Arr.some(
        blocks,
        (block) => block?.type === "text" && Boolean(block.text)
      );
    if (message.role === "assistant") {
      const response = assistantResponse(blocks);
      // a turn that only thought is dropped
      if (response.content !== "" || (response.toolUses?.length ?? 0) > 0) {
        mark(marked, addAssistant(entries, response), blocks);
      }
    } else if (!dropped) {
      mark(marked, addUser(entries, userInput(blocks, model)), blocks);
    }
  }
  return entries;
}

// dropLeading makes the conversation open with something the user said:
// tool results with no call before them go, and so does a reply the
// caller began with
function dropLeading(entries: Array<Entry>) {
  while (entries.length > 0) {
    const first = entries[0]?.userInputMessage;
    if (
      first !== undefined &&
      !(
        first.userInputMessageContext !== undefined &&
        first.content === "" &&
        (first.images?.length ?? 0) === 0
      )
    ) {
      delete first.userInputMessageContext;
      break;
    }
    entries.shift();
  }
}

// currentMessage is the message being answered, which the conversation
// ends with: the user's last, or an empty one added
function currentMessage(entries: Array<Entry>, model: string): UserInput {
  const last = entries.at(-1)?.userInputMessage;
  if (last !== undefined) {
    return last;
  }
  const current: UserInput = {
    content: "",
    images: [],
    modelId: model,
    origin: "KIRO_CLI",
  };
  entries.push({ userInputMessage: current });
  return current;
}

// answerCalls makes each call answered in the message after it, and only
// calls: a result with no call goes, and a call with no result gets one
function answerCalls(entries: Array<Entry>) {
  Arr.forEach(entries, (entry, i) => {
    const input = entry.userInputMessage;
    if (input === undefined) {
      return;
    }
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? [];
    const results = input.userInputMessageContext?.toolResults ?? [];
    const answered = new Set<string>();
    const kept: Array<ToolResult> = [];
    for (const result of results) {
      if (
        !answered.has(result.toolUseId) &&
        Arr.some(calls, (call) => call.toolUseId === result.toolUseId)
      ) {
        answered.add(result.toolUseId);
        kept.push(result);
      }
    }
    for (const call of calls) {
      if (!answered.has(call.toolUseId)) {
        answered.add(call.toolUseId);
        kept.push({
          content: [{ text: NO_RESULT }],
          status: "error",
          toolUseId: call.toolUseId,
        });
      }
    }
    delete input.userInputMessageContext;
    if (kept.length > 0) {
      input.userInputMessageContext = { toolResults: kept };
    }
    if (input.content === "" && input.userInputMessageContext === undefined) {
      input.content = PROCEED;
    }
  });
}

// keepLatestImages drops all but the latest images, as Kiro's own agent
// sends only those again
function keepLatestImages(entries: Array<Entry>) {
  let latest = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if ((entries[i]?.userInputMessage?.images?.length ?? 0) > 0) {
      latest = i;
      break;
    }
  }
  Arr.forEach(entries, (entry, i) => {
    const input = entry.userInputMessage;
    if (
      input !== undefined &&
      (i !== latest || (input.images?.length ?? 0) === 0)
    ) {
      delete input.images;
    }
  });
}

// systemText is the instructions the first message opens with: the
// request's system prompt, the answer's format (Kiro has no field for it,
// so it is told in words) and the thinking budget
function systemText(req: MessagesRequest, budget: number | undefined) {
  let system = Predicate.isString(req.system) ? req.system : textOf(req.system);
  const format = formatText(req);
  if (format !== "") {
    system = system === "" ? format : `${system}\n\n${format}`;
  }
  if (budget !== undefined && isSet(budget)) {
    system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${
      system === "" ? "" : `\n${system}`
    }`;
  }
  return system;
}

// kiroTools is the caller's tools, and any the conversation used that it
// no longer offers, since Kiro rejects a history naming a tool it wasn't given
function kiroTools(
  req: MessagesRequest,
  entries: Array<Entry>
): Array<KiroTool> {
  const tools: Array<KiroTool> = [];
  const offered = new Set<string>();
  const EMPTY = { properties: {}, type: "object" };
  for (const tool of req.tools ?? []) {
    const given = tool?.name;
    // server tools Kiro hasn't are left out
    const server = (kind: string | undefined) =>
      kind !== undefined &&
      kind !== "" &&
      kind !== "custom" &&
      !Predicate.isTruthy(tool.input_schema);
    if (given !== undefined && given !== "" && !server(tool.type)) {
      const name = toolName(given);
      offered.add(name);
      tools.push({
        toolSpecification: {
          description:
            tool.description === undefined || tool.description === ""
              ? given
              : tool.description,
          inputSchema: { json: tool.input_schema ?? EMPTY },
          name,
        },
      });
      if (Predicate.isTruthy(tool.cache_control)) {
        tools.push({ cachePoint: { type: "default" } });
      }
    }
  }
  for (const entry of entries) {
    for (const call of entry.assistantResponseMessage?.toolUses ?? []) {
      if (!offered.has(call.name)) {
        offered.add(call.name);
        tools.push({
          toolSpecification: {
            description: "Tool",
            inputSchema: { json: EMPTY },
            name: call.name,
          },
        });
      }
    }
  }
  return tools;
}

// placeCachePoints puts a cachePoint on each marked message. Kiro's
// cachePoint is Bedrock's: it caches the prompt up to the point, and a
// request may hold 4 at most; past that the last ones are kept, as they
// cover the most of the prompt
function placeCachePoints(
  tools: Array<KiroTool>,
  entries: Array<Entry>,
  marked: Marked
) {
  const points: Array<() => void> = [];
  for (const tool of tools) {
    if (tool.cachePoint !== undefined) {
      points.push(() => {
        tools.splice(tools.indexOf(tool), 1);
      });
    }
  }
  for (const entry of entries) {
    const message = entry.userInputMessage ?? entry.assistantResponseMessage;
    if (message !== undefined && marked.has(message)) {
      message.cachePoint = { type: "default" };
      points.push(() => {
        delete message.cachePoint;
      });
    }
  }
  for (const drop of points.slice(0, Math.max(0, points.length - 4))) {
    drop();
  }
}

// kiroRequest builds the Kiro request for req, for the profile it is sent with
const kiroRequest =
  (req: MessagesRequest, model: string, { budget, fields }: Thinking) =>
  (profile: string): KiroRequest => {
    const marked: Marked = new WeakSet();
    const entries = entriesOf(req, model, marked);
    dropLeading(entries);
    const current = currentMessage(entries, model);
    answerCalls(entries);
    keepLatestImages(entries);
    for (const entry of entries) {
      if (
        entry.assistantResponseMessage !== undefined &&
        (entry.assistantResponseMessage.toolUses?.length ?? 0) === 0
      ) {
        delete entry.assistantResponseMessage.toolUses;
      }
    }
    // the instructions go at the head of the first message, which the steps
    // above made the user's
    const first = entries[0]?.userInputMessage ?? current;
    const system = systemText(req, budget);
    if (system !== "") {
      first.content = `${system}\n\n${first.content}`;
    }
    if (Arr.isArray(req.system)) {
      mark(marked, first, req.system);
    }

    const tools = kiroTools(req, entries);
    if (tools.length > 0) {
      (current.userInputMessageContext ??= {}).tools = tools;
    }
    placeCachePoints(tools, entries, marked);

    const out: KiroRequest = {
      agentMode: "vibe",
      conversationState: {
        agentTaskType: "vibe",
        chatTriggerType: "MANUAL",
        conversationId: randomUUID(),
        currentMessage: { userInputMessage: current },
      },
    };
    if (entries.length > 1) {
      out.conversationState.history = entries.slice(0, -1);
    }
    if (profile !== "") {
      out.profileArn = profile;
    }
    if (fields !== undefined) {
      out.additionalModelRequestFields = fields;
    }
    return out;
  };

// ---- the reply: an AWS event stream → Messages ---------------------------------------

// the size of each header value type that isn't a string or bytes
const HEADER_SIZES = new Map([
  [0, 0],
  [1, 0],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [8, 8],
  [9, 16],
]);

function frameHeaders(headers: Uint8Array) {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  const view = new DataView(
    headers.buffer,
    headers.byteOffset,
    headers.byteLength
  );
  let i = 0;
  while (i < headers.length) {
    const nameLength = view.getUint8(i);
    if (headers.length < i + 2 + nameLength) {
      break;
    }
    const name = dec.decode(headers.subarray(i + 1, i + 1 + nameLength));
    const type = view.getUint8(i + 1 + nameLength);
    i += 2 + nameLength;
    if (type === 6 || type === 7) {
      if (headers.length < i + 2) {
        break;
      }
      const length = view.getUint16(i);
      if (headers.length < i + 2 + length) {
        break;
      }
      if (type === 7) {
        out[name] = dec.decode(headers.subarray(i + 2, i + 2 + length));
      }
      i += 2 + length;
    } else {
      const size = HEADER_SIZES.get(type);
      if (size === undefined || headers.length < i + size) {
        break;
      }
      i += size;
    }
  }
  return out;
}

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>";
const CLOSE = "</thinking>";
function partialSuffix(text: string, tag: string) {
  for (
    let length = Math.min(tag.length - 1, text.length);
    length > 0;
    length -= 1
  ) {
    if (Str.endsWith(Str.slice(0, length)(tag))(text)) {
      return length;
    }
  }
  return 0;
}

interface Said {
  kind: "text" | "think";
  text: string;
}

class ThinkParser {
  private state = 0; // 0: not yet known, 1: thinking, 2: text
  private buf = "";
  private said = false;
  public feed(piece: string): Array<Said> {
    this.buf += piece;
    const out: Array<Said> = [];
    // each step reads what it can, until one needs more of the reply
    let more = true;
    while (more) {
      more = this.step(out);
    }
    return out;
  }
  public end(): Array<Said> {
    if (this.buf === "") {
      return [];
    }
    const ev: Said = {
      kind: this.state === 1 ? "think" : "text",
      text: this.buf,
    };
    this.buf = "";
    if (this.state === 0) {
      this.state = 2;
    }
    return [ev];
  }
  // step reads the buffer in the current state, and says whether to read on
  private step(out: Array<Said>): boolean {
    if (this.state === 0) {
      const trimmed = Str.replace(/^[ \t\r\n]+/u, "")(this.buf);
      if (Str.startsWith(OPEN)(trimmed)) {
        [this.buf, this.state] = [Str.slice(OPEN.length)(trimmed), 1];
        return true;
      }
      if (trimmed.length < OPEN.length && Str.startsWith(trimmed)(OPEN)) {
        return false; // may yet be the tag
      }
      this.state = 2;
      return true;
    }
    if (this.state === 1) {
      if (!this.said) {
        this.buf = Str.replace(/^[\r\n]+/u, "")(this.buf);
        if (this.buf === "") {
          return false;
        }
      }
      const found = Str.indexOf(CLOSE)(this.buf);
      if (Option.isSome(found)) {
        const i = found.value;
        if (i > 0) {
          out.push({ kind: "think", text: Str.slice(0, i)(this.buf) });
          this.said = true;
        }
        const after = Str.slice(i + CLOSE.length)(this.buf);
        [this.buf, this.state] = [Str.replace(/^[\r\n]+/u, "")(after), 2];
        return true;
      }
      // hold back what may be the start of the closing tag
      const sure = this.buf.length - partialSuffix(this.buf, CLOSE);
      if (sure > 0) {
        out.push({ kind: "think", text: Str.slice(0, sure)(this.buf) });
        [this.buf, this.said] = [Str.slice(sure)(this.buf), true];
      }
      return false;
    }
    if (this.buf !== "") {
      out.push({ kind: "text", text: this.buf });
    }
    this.buf = "";
    return false;
  }
}

export interface Usage {
  cacheRead: number;
  cacheWrite: number;
  credits: number; // what the reply cost, from its meteringEvents
  input: number;
  output: number;
  reported: boolean; // Kiro sent token counts
}

// KiroEvent is a piece of Kiro's reply, as reply turns it into Messages events.
type KiroEvent =
  | Said
  | { kind: "sig" | "toolArgs"; text: string }
  | { id: string; kind: "toolStart"; name: string }
  | ({ kind: "error" } & Failure)
  | { kind: "stop"; reason: string; usage: Usage };

// what the payload of each event Kiro sends may hold
const count = field(Schema.Finite);
const Payload = Schema.Struct({
  content: Schema.optional(Schema.Unknown),
  contextUsagePercentage: count,
  input: Schema.optional(Schema.Unknown),
  name: field(Schema.String),
  signature: field(Schema.String),
  stopReason: field(Schema.String),
  text: field(Schema.String),
  tokenUsage: field(
    Schema.Struct({
      cacheReadInputTokens: count,
      cacheWriteInputTokens: count,
      contextUsagePercentage: count,
      inputTokens: count,
      outputTokens: count,
      uncachedInputTokens: count,
    })
  ),
  toolUseId: field(Schema.String),
  usage: count, // a meteringEvent's credits
});
type Payload = typeof Payload.Type;
const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Payload)
);

const FAILURE_EVENTS = new Set([
  "error",
  "throttlingError",
  "validationError",
  "serviceUnavailableError",
  "internalServerException",
]);

// ReplyDecoder reads Kiro's reply, an AWS event stream, piece by piece into
// events: text, thinking, tool calls (the arguments in pieces), then the
// usage and why it stopped, or an error. Each message of the stream is its
// length, its headers' length and a checksum, the headers, the payload, and
// a checksum of the whole.
class ReplyDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly think = new ThinkParser();
  private tool = "";
  private tools = 0;
  private stop = "";
  // Kiro sends no token counts today, only how full the context is
  // (contextUsageEvent) and the credits spent (meteringEvent)
  private readonly usage: Usage = {
    cacheRead: 0,
    cacheWrite: 0,
    credits: 0,
    input: 0,
    output: 0,
    reported: false,
  };
  private pct = 0;
  private said = 0;
  private heard = false; // a message of the stream arrived
  private failed: Failure | undefined = undefined;
  private ended = false;
  private readonly window: number; // the model's context, to reckon the input from
  private readonly budget: number | undefined; // the thinking budget the prompt set

  public constructor(window: number, budget: number | undefined) {
    this.window = window;
    this.budget = budget;
  }

  // done is whether the reply has failed, so no more of it need be read
  public get done() {
    return this.failed !== undefined;
  }

  // push reads a piece of the body: the events of each message it completes.
  public push(chunk: Uint8Array): Array<KiroEvent> {
    const out: Array<KiroEvent> = [];
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    while (this.failed === undefined && this.buf.length >= 12) {
      const view = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength
      );
      const total = view.getUint32(0);
      const hlen = view.getUint32(4);
      if (total < 16 || total > 16 * 2 ** 20 || hlen > total - 16) {
        this.broke("its event stream was malformed");
        break;
      }
      if (this.buf.length < total) {
        break;
      }
      this.heard = true;
      const rest = this.buf.subarray(12, total);
      this.message(
        frameHeaders(rest.subarray(0, hlen)),
        rest.subarray(hlen, -4),
        out
      );
      this.buf = this.buf.slice(total);
    }
    return out;
  }

  // broke is the body failing before its end
  public broke(message: string) {
    this.fail(brokeOff(message));
  }

  // fail is the reply failing: the first failure is the one said
  public fail(failure: Failure) {
    this.failed ??= failure;
  }

  // end is what is left once the body is read: the rest of the text, then
  // why it stopped, or the failure. A body with no message at all is an
  // empty reply. One with any, even a meteringEvent alone, is a reply, so
  // what it cost is counted and it isn't sent (and charged for) again.
  public end(): Array<KiroEvent> {
    if (this.ended) {
      return [];
    }
    this.ended = true;
    if (this.buf.length > 0) {
      this.broke("the connection closed partway through an event");
    } else if (!this.heard) {
      this.fail(emptyReply);
    }
    const out: Array<KiroEvent> = this.think.end();
    if (this.failed !== undefined) {
      out.push({ kind: "error", ...this.failed });
      return out;
    }
    const { usage } = this;
    // Kiro says how full the context is rather than how many tokens
    if (!isSet(usage.input) && this.pct > 0 && this.window > 0) {
      usage.input = Math.floor((this.pct / 100) * this.window);
    }
    if (!isSet(usage.output)) {
      usage.output = Math.floor((this.said + 3) / 4);
    }
    let reason = "end_turn";
    if (this.tools > 0) {
      reason = "tool_use";
    } else if (/^max_tokens$/iu.test(this.stop)) {
      reason = "max_tokens";
    } else if (/^content_filtered$/iu.test(this.stop)) {
      reason = "refusal";
    }
    out.push({ kind: "stop", reason, usage });
    return out;
  }

  private message(
    headers: Record<string, string>,
    payload: Uint8Array,
    out: Array<KiroEvent>
  ) {
    const type = headers[":message-type"];
    if (type === "exception" || type === "error") {
      const exception = headers[":exception-type"];
      this.failed = fromException(
        exception === undefined || exception === ""
          ? headers[":error-code"]
          : exception,
        new TextDecoder().decode(payload)
      );
      return;
    }
    const kind = headers[":event-type"];
    if (kind !== undefined && kind !== "" && FAILURE_EVENTS.has(kind)) {
      this.failed = fromException(kind, new TextDecoder().decode(payload));
      return;
    }
    const event = Option.getOrUndefined(
      decodePayload(new TextDecoder().decode(payload))
    );
    if (event === undefined) {
      return;
    }
    if (kind === "assistantResponseEvent") {
      this.assistantResponse(event, out);
    } else if (kind === "reasoningContentEvent") {
      this.reasoningContent(event, out);
    } else if (kind === "toolUseEvent") {
      this.toolUse(event, out);
    } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
      this.metadata(event);
    } else if (kind === "contextUsageEvent") {
      const pct = event.contextUsagePercentage ?? 0;
      if (pct > 0) {
        this.pct = pct;
      }
    } else if (kind === "meteringEvent") {
      const credits = event.usage ?? 0;
      if (credits > 0) {
        this.usage.credits += credits;
      }
    }
  }

  private assistantResponse(event: Payload, out: Array<KiroEvent>) {
    const text = Predicate.isString(event.content) ? event.content : "";
    this.said += text.length;
    if (this.budget !== undefined && isSet(this.budget)) {
      out.push(...this.think.feed(text));
    } else if (text !== "") {
      out.push({ kind: "text", text });
    }
  }

  private reasoningContent(event: Payload, out: Array<KiroEvent>) {
    const text = event.text ?? "";
    const signature = event.signature ?? "";
    if (text !== "") {
      this.said += text.length;
      out.push({ kind: "think", text });
    } else if (signature !== "") {
      out.push({ kind: "sig", text: signature });
    }
  }

  private toolUse(event: Payload, out: Array<KiroEvent>) {
    const id = event.toolUseId ?? "";
    if (id !== "" && id !== this.tool) {
      out.push(...this.think.end()); // the text before a call is all said
      this.tool = id;
      this.tools += 1;
      out.push({
        id,
        kind: "toolStart",
        name: event.name ?? "",
      });
    }
    if (event.input === undefined || event.input === null) {
      return;
    }
    if (Predicate.isString(event.input)) {
      if (event.input !== "") {
        out.push({ kind: "toolArgs", text: event.input });
      }
      this.said += event.input.length;
    } else {
      // oxlint-disable-next-line effecttsgo/global-json -- the input was decoded from Kiro's JSON payload, so stringify cannot throw
      const json = JSON.stringify(event.input);
      if (json !== "{}") {
        out.push({ kind: "toolArgs", text: json });
      }
      this.said += json.length;
    }
  }

  private metadata(event: Payload) {
    const stopReason = event.stopReason ?? "";
    if (stopReason !== "") {
      this.stop = stopReason;
    }
    const tokens = event.tokenUsage;
    if (tokens === undefined || tokens === null) {
      return;
    }
    const { usage } = this;
    usage.reported = true;
    // an uncached count of 0 falls back to the whole input count
    const uncached = tokens.uncachedInputTokens ?? 0;
    usage.input += uncached === 0 ? (tokens.inputTokens ?? 0) : uncached;
    usage.output += tokens.outputTokens ?? 0;
    usage.cacheRead += tokens.cacheReadInputTokens ?? 0;
    usage.cacheWrite += tokens.cacheWriteInputTokens ?? 0;
    const pct = tokens.contextUsagePercentage ?? 0;
    if (pct > 0) {
      this.pct = pct;
    }
  }
}

// events is Kiro's reply body as events. However the body ends, the last
// event says how: a stop, or an error. A body that sends nothing for
// idleSeconds, before its first event or between two, ends in a stall.
// how events reads a reply: the model's context, the thinking budget the
// prompt set, and how long the body may send nothing
interface Reading {
  budget: number | undefined;
  idleSeconds: number;
  window: number;
}

const events = (
  body: Stream.Stream<Uint8Array, unknown>,
  { budget, idleSeconds, window }: Reading
): Stream.Stream<KiroEvent> =>
  Stream.suspend(() => {
    const reader = new ReplyDecoder(window, budget);
    return body.pipe(
      Stream.timeoutOrElse({
        duration: `${idleSeconds} seconds`,
        orElse: () => Stream.fail(new Cause.TimeoutError()),
      }),
      Stream.map((chunk) => reader.push(chunk)),
      Stream.takeUntil(() => reader.done),
      Stream.flattenIterable,
      Stream.catchCause((cause) => {
        reader.fail(fromBody(cause, idleSeconds));
        return Stream.empty;
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(reader.end())))
    );
  });

// anthropicUsage is the usage in Messages' words. Without counts from Kiro
// the input is reckoned from how full the context is, and the cache fields,
// unknown, are left out.
const anthropicUsage = (usage: Usage) =>
  usage.reported
    ? {
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        input_tokens: usage.input,
        output_tokens: usage.output,
      }
    : { input_tokens: usage.input, output_tokens: usage.output };

// the fields of an SSE event's data besides its type; JSON.stringify drops
// one that is undefined
interface SseData {
  readonly [field: string]: Schema.Json | SseData | undefined;
}

// MessagesEncoder writes Kiro's events as Anthropic's SSE events. names
// gives back the caller's name for a tool Kiro was sent under another
// (toolNames).
class MessagesEncoder {
  private readonly id = `msg_${randomBytes(12).toString("hex")}`;
  private readonly enc = new TextEncoder();
  private index = -1;
  private open = ""; // the kind of block open
  private started = false;
  private readonly model: string;
  private readonly names: Map<string, string>;

  public constructor(model: string, names: Map<string, string>) {
    this.model = model;
    this.names = names;
  }

  public encode(event: KiroEvent): Array<Uint8Array> {
    const out: Array<Uint8Array> = [];
    const sse = (type: string, data: SseData) => {
      // oxlint-disable-next-line effecttsgo/global-json -- SseData holds only JSON values, so stringify cannot throw
      const json = JSON.stringify({ type, ...data });
      out.push(this.enc.encode(`event: ${type}\ndata: ${json}\n\n`));
    };
    const close = () => {
      if (this.open !== "") {
        sse("content_block_stop", { index: this.index });
      }
      this.open = "";
    };
    const begin = (kind: string, block: SseData) => {
      close();
      this.index += 1;
      this.open = kind;
      sse("content_block_start", { content_block: block, index: this.index });
    };
    if (!this.started) {
      this.started = true;
      sse("message_start", {
        message: {
          content: [],
          id: this.id,
          model: this.model,
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    const index = () => this.index;
    switch (event.kind) {
      case "text": {
        if (this.open !== "text") {
          begin("text", { text: "", type: "text" });
        }
        sse("content_block_delta", {
          delta: { text: event.text, type: "text_delta" },
          index: index(),
        });
        break;
      }
      case "think": {
        if (this.open !== "thinking") {
          begin("thinking", { signature: "", thinking: "", type: "thinking" });
        }
        sse("content_block_delta", {
          delta: { thinking: event.text, type: "thinking_delta" },
          index: index(),
        });
        break;
      }
      case "sig": {
        if (this.open === "thinking") {
          sse("content_block_delta", {
            delta: { signature: event.text, type: "signature_delta" },
            index: index(),
          });
        }
        break;
      }
      case "toolStart": {
        begin("tool", {
          id: event.id,
          input: {},
          name: this.names.get(event.name) ?? event.name,
          type: "tool_use",
        });
        break;
      }
      case "toolArgs": {
        if (this.open === "tool") {
          sse("content_block_delta", {
            delta: { partial_json: event.text, type: "input_json_delta" },
            index: index(),
          });
        }
        break;
      }
      case "error": {
        close();
        sse("error", { error: toError(event) });
        break;
      }
      case "stop": {
        close();
        sse("message_delta", {
          delta: { stop_reason: event.reason, stop_sequence: null },
          usage: anthropicUsage(event.usage),
        });
        sse("message_stop", {});
        break;
      }
      default: {
        break;
      }
    }
    return out;
  }
}

const isLast = (event: KiroEvent) =>
  event.kind === "error" || event.kind === "stop";

// reply answers the Messages request from Kiro's events, as a stream of
// Messages events. finished is told the usage of a reply that ends well.
// what reply answers with: the model the caller asked for, and its names
// for the tools Kiro was sent under others
interface Answering {
  model: string;
  names: Map<string, string>;
}

const reply = Effect.fnUntraced(function* (
  kiro: Stream.Stream<KiroEvent>,
  { model, names }: Answering,
  finished: (usage: Usage) => Effect.Effect<void>
) {
  // the first event is read before answering: an error before any of the
  // answer is a status, so OpenCode can retry it or say why. The rest of
  // the reply lives in this scope until the answer's body is read or let go.
  // Stream.peel (effect 4.0.1) drops what is left of the chunk its sink
  // ends in, so the events go one to a chunk.
  const scope = yield* Scope.make();
  const [head, rest] = yield* Stream.peel(
    Stream.rechunk(kiro, 1),
    Sink.head<KiroEvent>()
  ).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void))
  );
  const first = Option.getOrUndefined(head);
  if (first === undefined || first.kind === "error") {
    yield* Scope.close(scope, Exit.void);
    return toResponse(first ?? emptyReply);
  }
  const body = Stream.concat(Stream.make(first), rest).pipe(
    Stream.takeUntil(isLast),
    Stream.tap((event) =>
      event.kind === "stop" ? finished(event.usage) : Effect.void
    ),
    Stream.mapAccum(
      () => new MessagesEncoder(model, names),
      (encoder, event) => [encoder, encoder.encode(event)] as const
    ),
    Stream.ensuring(Scope.close(scope, Exit.void))
  );
  return new Response(Stream.toReadableStream(body), {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
    },
    status: 200,
  });
});

// ---- a turn ------------------------------------------------------------------------------

// Turn is one Messages request, opened: what Kiro is sent for it, and how
// Kiro's answer is turned back into Messages. Each request is a new
// conversation, with a new id. answer reads the first event before it
// answers: a failure before any of the reply is an error response with its
// status, and one after is the SSE stream's last event, an error. finished
// is told the usage of a reply that ends well. A body that sends nothing
// for idleSeconds, before its first event or between two, ends in a stall.
export interface Turn {
  readonly answer: (
    body: Stream.Stream<Uint8Array, unknown>,
    finished: (usage: Usage) => Effect.Effect<void>,
    idleSeconds?: number
  ) => Effect.Effect<Response>;
  readonly request: (profile: string) => KiroRequest;
}

// open opens a turn of req, on the model of models it names. A model not
// among them is sent as named, and thinks as its id says (see thinks).
export function open(
  req: MessagesRequest,
  models: ReadonlyArray<KiroModel>
): Turn {
  const model = req.model ?? "auto";
  const kiroModel = Option.getOrUndefined(
    Arr.findFirst(models, (listed) => listed.id === model)
  );
  const thinking = thinkingOf(req, model, kiroModel);
  const names = toolNames(req);
  return {
    answer: (body, finished, idleSeconds = IDLE_SECONDS) =>
      reply(
        events(body, {
          budget: thinking.budget,
          idleSeconds,
          window: kiroModel?.context ?? 0,
        }),
        { model, names },
        finished
      ),
    request: kiroRequest(req, model, thinking),
  };
}
