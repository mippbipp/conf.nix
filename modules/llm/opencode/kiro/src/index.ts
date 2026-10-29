// Kiro as an OpenCode 2 provider, on kiro-cli's auth.
//
// OpenCode stores nothing for it. Each request reads the token kiro-cli
// keeps in its SQLite database (the Kiro IDE's when kiro-cli isn't signed
// in), has kiro-cli refresh it when it is about to run out, and writes back
// a token refreshed here so kiro-cli carries on with it.
//
// Kiro has no API OpenCode speaks. The provider sits on OpenCode's native
// Anthropic Messages route, and two session hooks do the translating.
// http.request turns each Messages request into a call to Kiro's
// generateAssistantResponse (the API kiro-cli uses), and http.response
// turns the AWS event stream Kiro answers with back into Messages events.
//
// OpenCode loads this file as it is: Bun strips the types, and OpenCode
// supplies `effect` and `@opencode/plugin` itself, so the plugin may import
// only those, Bun's and Node's own modules, and the files beside it. The
// no-restricted-imports rule in ../oxlint.config.ts fails lint on any other.
//
// The sidebar (tui.tsx) shows the account's usage and what each session has
// spent, which it asks for over the RPC in rpc.ts.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Plugin, Provider } from "@opencode/plugin/effect";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Sink,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type Auth, authHeaders, KiroAccount } from "./account.ts";
import * as Failure from "./failure.ts";
import { field, ID, send } from "./kiro.ts";
import {
  BUDGETS,
  decodeSaved,
  FALLBACK,
  type KiroModel,
  modelInfo,
  modelOf,
  thinks,
} from "./models.ts";
import { type AccountUsage, KiroRpc, type UsageAnswer } from "./rpc.ts";

const PACKAGE = "@opencode/ai/providers/anthropic";
// where the Anthropic route posts; http.request sends it on to the account's region
const BASE = "https://runtime.us-east-1.kiro.dev";
const MODELS_KEY = "models";

const runtime = (region: string) => `https://runtime.${region}.kiro.dev`;
const codeOf = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e ? e.code : undefined;

// Kiro's reply is dropped after this long with nothing from Kiro, the
// default of kiro-cli's own watchdog (api.streamIdleHardTimeout). A 504
// that OpenCode retries.
const IDLE_SECONDS = 300;
// how long Kiro may take to answer a request this plugin sends itself
// (the one resent with a refreshed token) before it starts the reply
const HEADERS_SECONDS = 60;

// ---- usage -----------------------------------------------------------------------

// what each session has spent, kept in the plugin's storage
const creditsKey = (sessionID: string) => `credits/${sessionID}`;
const decodeCredits = Schema.decodeUnknownOption(Schema.Number);
const decodeUsageInput = Schema.decodeUnknownEffect(
  Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
);

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

// ---- the request: Messages → a Kiro conversation ---------------------------------------

// The parts of an Anthropic Messages request the plugin reads. OpenCode's
// own Anthropic route writes it, so it is taken to be of this shape, and
// every field is still read as if it might be missing.
interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Block[];
  title?: string;
  source?: { type?: string; data?: string; media_type?: string; content?: string | Block[] };
  cache_control?: unknown;
}
interface Message {
  role?: string;
  content?: string | Block[];
}
interface Tool {
  name?: string;
  type?: string;
  description?: string;
  input_schema?: unknown;
  cache_control?: unknown;
}
interface OutputFormat {
  type?: string;
  schema?: unknown;
}
interface MessagesRequest {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: string | Block[];
  messages?: Message[];
  tools?: Tool[];
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string; format?: OutputFormat };
  output_format?: OutputFormat;
}

// A Kiro conversation, as generateAssistantResponse takes it.
interface KiroImage {
  format: string;
  source: { bytes: string };
}
interface ToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: { text: string }[];
}
type CachePoint = { type: "default" };
type KiroTool =
  | {
      toolSpecification: { name: string; description: string; inputSchema: { json: unknown } };
      cachePoint?: never;
    }
  | { cachePoint: CachePoint; toolSpecification?: never };
interface UserInput {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: ToolResult[]; tools?: KiroTool[] };
  cachePoint?: CachePoint;
}
interface ToolUse {
  name: string;
  toolUseId: string;
  input: object;
}
interface AssistantResponse {
  content: string;
  toolUses?: ToolUse[];
  cachePoint?: CachePoint;
}
interface Entry {
  userInputMessage?: UserInput;
  assistantResponseMessage?: AssistantResponse;
}
// the thinking fields Kiro passes on to the model
interface Fields {
  thinking?: { type: "adaptive" | "disabled"; display?: "summarized" };
  output_config?: { effort: string };
  reasoning?: { effort: string };
  max_tokens?: number;
}
interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: UserInput };
    history?: Entry[];
  };
  agentMode: "vibe";
  profileArn?: string;
  additionalModelRequestFields?: Fields;
}

const PROCEED = "Please proceed with the task."; // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const RESULT_LIMIT = 250000; // a tool's output is cut at this, as Kiro's own agent cuts it
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
const toolID = (id: string | undefined) =>
  id && TOOL_ID.test(id)
    ? id
    : "t_" +
      createHash("sha256")
        .update(String(id ?? ""))
        .digest("base64url")
        .slice(0, 32);

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), and
// MCP tool names can run longer.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so later turns name it the
// same way. toolNames maps each such name back.
const toolName = (name: string | undefined) => {
  const n = String(name ?? "");
  if (TOOL_NAME.test(n)) return n;
  const hash = createHash("sha256").update(n).digest("hex").slice(0, 12);
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length) + "_" + hash;
};

// toolNames is the name the caller knows for each tool a request names that
// Kiro is sent under another name.
function toolNames(req: MessagesRequest) {
  const names = new Map<string, string>();
  const add = (n: unknown) => {
    if (typeof n !== "string" || !n) return;
    const k = toolName(n);
    if (k !== n) names.set(k, n);
  };
  for (const t of req.tools ?? []) add(t?.name);
  for (const m of req.messages ?? [])
    if (Array.isArray(m.content))
      for (const p of m.content) if (p?.type === "tool_use") add(p.name);
  return names;
}

function imageFormat(mediaType: string | undefined) {
  const t = String(mediaType ?? "").toLowerCase();
  const f = t.replace(/^image\//, "");
  if (f === "jpg") return "jpeg";
  if (!f || f === t) return "png";
  return f;
}

// addImage puts an Anthropic image block in images as Kiro takes it, the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images: KiroImage[], p: Block) {
  if (p.source?.type === "base64" && p.source.data)
    images.push({ format: imageFormat(p.source.media_type), source: { bytes: p.source.data } });
}

const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((p: Block) => p?.type === "text")
          .map((p: Block) => p.text ?? "")
          .join("\n\n")
      : "";
const joinNonEmpty = (a: string, b: string) => (a && b ? a + "\n\n" + b : a + b);

function documentText(p: Block) {
  const title = p.title ? `${p.title}\n` : "";
  if (p.source?.type === "text") return title + (p.source.data ?? "");
  if (p.source?.type === "content") return title + textOf(p.source.content);
  return `${title}[a ${p.source?.media_type ?? "document"} attachment]`;
}

// Thinking is how the model is asked to think: request fields, or a budget
// told in the prompt.
interface Thinking {
  budget?: number;
  fields?: Fields;
}

// thinkingOf is how the model is asked to think, from the effort the
// variant set (output_config.effort): the request fields Kiro lists for the
// model (m), or, for a model it lists none for, a thinking budget for the
// prompt.
function thinkingOf(req: MessagesRequest, model: string, m: KiroModel | undefined): Thinking {
  const effort = req.output_config?.effort;
  if (m?.fields) {
    if (!effort) return {};
    const fields: Fields = {};
    if (m.fields === "openai") {
      if (m.efforts.includes(effort)) fields.reasoning = { effort };
    } else if (effort === "none") {
      if (m.off) fields.thinking = { type: "disabled" };
    } else if (m.efforts.includes(effort)) {
      fields.thinking = { type: "adaptive", ...(m.summarized ? { display: "summarized" } : {}) };
      fields.output_config = { effort };
    }
    if (m.maxTokens && req.max_tokens && req.max_tokens > 0)
      fields.max_tokens = Math.min(Math.max(req.max_tokens, m.maxTokens[0]), m.maxTokens[1]);
    return Object.keys(fields).length ? { fields } : {};
  }
  if (!thinks(model)) return {};
  if (
    req.thinking?.type === "enabled" &&
    req.thinking.budget_tokens &&
    req.thinking.budget_tokens > 0
  )
    return { budget: req.thinking.budget_tokens };
  const budget = effort ? BUDGETS[effort] : undefined;
  return budget ? { budget } : {};
}

// formatText is the structured output a request asks for, said in words:
// output_config.format with a JSON schema, "" when it asks for none.
function formatText(req: MessagesRequest) {
  const f = req.output_config?.format ?? req.output_format;
  if (f?.type !== "json_schema" || !f.schema || typeof f.schema !== "object") return "";
  return (
    "Respond with a single JSON value and nothing else, matching this JSON schema:\n" +
    JSON.stringify(f.schema) +
    "."
  );
}

function kiroRequest(
  req: MessagesRequest,
  model: string,
  profile: string,
  { budget, fields }: Thinking = {}
): KiroRequest {
  const entries: Entry[] = [];
  // the messages the caller marked for its prompt cache (cache_control),
  // which go to Kiro as a cachePoint on the message they end up in
  const marked = new WeakSet<UserInput | AssistantResponse>();
  const mark = (msg: UserInput | AssistantResponse, parts: Block[]) => {
    if (parts.some((p) => p?.cache_control)) marked.add(msg);
  };
  const user = (): UserInput => ({ content: "", modelId: model, origin: "KIRO_CLI" });
  for (const m of req.messages ?? []) {
    const parts: Block[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    // Kiro has no system role mid-conversation: an update's text is said as
    // the user's, and one with no text (an effort change) is dropped
    if (m.role === "system" && !parts.some((p) => p?.type === "text" && p.text)) continue;
    const texts: string[] = [];
    if (m.role === "assistant") {
      const a: AssistantResponse = { content: "", toolUses: [] };
      for (const p of parts) {
        if (p?.type === "text" && p.text) texts.push(p.text);
        else if (p?.type === "tool_use") {
          const input =
            p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {};
          a.toolUses!.push({ name: toolName(p.name), toolUseId: toolID(p.id), input });
        }
      }
      a.content = texts.join("\n\n");
      if (!a.content && !a.toolUses!.length) continue; // a turn that only thought
      const prev = entries.at(-1)?.assistantResponseMessage;
      if (prev) {
        prev.content = joinNonEmpty(prev.content, a.content);
        prev.toolUses!.push(...a.toolUses!);
      } else entries.push({ assistantResponseMessage: a });
      mark(prev ?? a, parts);
      continue;
    }
    const u = user();
    const images: KiroImage[] = [];
    u.images = images;
    const results: ToolResult[] = [];
    for (const p of parts) {
      if (p?.type === "text") {
        if (p.text) texts.push(p.text);
      } else if (p?.type === "document") texts.push(documentText(p));
      else if (p?.type === "image") addImage(images, p);
      else if (p?.type === "tool_result") {
        let out = textOf(p.content);
        if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + "\n… (cut)";
        results.push({
          toolUseId: toolID(p.tool_use_id),
          status: p.is_error ? "error" : "success",
          content: [{ text: out || "(no output)" }],
        });
        // a tool's images (a screenshot) go with the message, as Kiro's tool
        // results carry text alone
        if (Array.isArray(p.content))
          for (const c of p.content) if (c?.type === "image") addImage(images, c);
      }
    }
    u.content = texts.join("\n\n");
    if (results.length) u.userInputMessageContext = { toolResults: results };
    const prev = entries.at(-1)?.userInputMessage;
    if (prev) {
      prev.content = joinNonEmpty(prev.content, u.content);
      prev.images!.push(...images);
      if (results.length)
        (prev.userInputMessageContext ??= { toolResults: [] }).toolResults!.push(...results);
    } else entries.push({ userInputMessage: u });
    mark(prev ?? u, parts);
  }
  // the conversation opens with something the user said: tool results with
  // no call before them go, and so does a reply the caller began with
  while (entries.length) {
    const u = entries[0]?.userInputMessage;
    if (u) {
      if (u.userInputMessageContext && !u.content && !u.images?.length) {
        entries.shift();
        continue;
      }
      delete u.userInputMessageContext;
      break;
    }
    entries.shift();
  }
  // and ends with it, the message being answered
  let current = entries.at(-1)?.userInputMessage;
  if (!current) {
    current = { ...user(), images: [] };
    entries.push({ userInputMessage: current });
  }
  // each call is answered in the message after it, and only calls are
  entries.forEach((e, i) => {
    const u = e.userInputMessage;
    if (!u) return;
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? [];
    const results = u.userInputMessageContext?.toolResults ?? [];
    const answered = new Set<string>();
    const kept: ToolResult[] = [];
    for (const r of results)
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId);
        kept.push(r);
      }
    for (const c of calls)
      if (!answered.has(c.toolUseId)) {
        answered.add(c.toolUseId);
        kept.push({ toolUseId: c.toolUseId, status: "error", content: [{ text: NO_RESULT }] });
      }
    delete u.userInputMessageContext;
    if (kept.length) u.userInputMessageContext = { toolResults: kept };
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED;
  });
  // only the latest images are sent again, as Kiro's own agent does
  let latest = -1;
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]?.userInputMessage?.images?.length) {
      latest = i;
      break;
    }
  entries.forEach((e, i) => {
    const u = e.userInputMessage;
    if (u && (i !== latest || !u.images?.length)) delete u.images;
  });
  for (const e of entries)
    if (e.assistantResponseMessage && !e.assistantResponseMessage.toolUses?.length)
      delete e.assistantResponseMessage.toolUses;
  // the instructions go at the head of the first message, which the loops
  // above made the user's
  const first = entries[0]?.userInputMessage ?? current;
  let system = typeof req.system === "string" ? req.system : textOf(req.system);
  // Kiro has no field for the answer's format, so it is told in words
  const format = formatText(req);
  if (format) system = system ? system + "\n\n" + format : format;
  if (budget)
    system =
      `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>` +
      (system ? "\n" + system : "");
  if (system) first.content = system + "\n\n" + first.content;
  if (Array.isArray(req.system)) mark(first, req.system);

  // the caller's tools, and any the conversation used that it no longer
  // offers, since Kiro rejects a history naming a tool it wasn't given
  const tools: KiroTool[] = [];
  const offered = new Set<string>();
  const EMPTY = { type: "object", properties: {} };
  for (const t of req.tools ?? []) {
    if (!t?.name || (t.type && t.type !== "custom" && !t.input_schema)) continue; // server tools Kiro hasn't
    const name = toolName(t.name);
    offered.add(name);
    tools.push({
      toolSpecification: {
        name,
        description: t.description || t.name,
        inputSchema: { json: t.input_schema ?? EMPTY },
      },
    });
    if (t.cache_control) tools.push({ cachePoint: { type: "default" } });
  }
  for (const e of entries)
    for (const c of e.assistantResponseMessage?.toolUses ?? [])
      if (!offered.has(c.name)) {
        offered.add(c.name);
        tools.push({
          toolSpecification: { name: c.name, description: "Tool", inputSchema: { json: EMPTY } },
        });
      }
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools;
  // Kiro's cachePoint is Bedrock's: it caches the prompt up to the point, and
  // a request may hold 4 at most; past that the last ones are kept, as they
  // cover the most of the prompt
  const points: (() => void)[] = [];
  for (const t of tools)
    if (t.cachePoint)
      points.push(() => {
        tools.splice(tools.indexOf(t), 1);
      });
  for (const e of entries) {
    const msg = e.userInputMessage ?? e.assistantResponseMessage;
    if (msg && marked.has(msg)) {
      msg.cachePoint = { type: "default" };
      points.push(() => {
        delete msg.cachePoint;
      });
    }
  }
  for (const drop of points.slice(0, Math.max(0, points.length - 4))) drop();

  const out: KiroRequest = {
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId: randomUUID(),
      currentMessage: { userInputMessage: current },
    },
    agentMode: "vibe",
  };
  if (entries.length > 1) out.conversationState.history = entries.slice(0, -1);
  if (profile) out.profileArn = profile;
  if (fields) out.additionalModelRequestFields = fields;
  return out;
}

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

// ---- images over Kiro's size limit ---------------------------------------------------
//
// Kiro turns away an image whose Base64 is over 5 MiB, counted on the encoded
// string, not the file (magpie-community/plugins#428), and the image stays in
// history, so every later turn would fail the same way. An image over the
// limit is made smaller on the request being sent, and one that can't be is
// replaced by a note.
const IMAGE_LIMIT = 5 * 1024 * 1024; // Base64 characters
const IMAGE_EDGE = 2000; // a shrunk image's long edge (kirodotdev/Kiro#8884)
const IMAGE_MIN_EDGE = 256;
const IMAGE_MAX_PIXELS = 50_000_000; // a header claiming more is refused unread
const IMAGE_MAX_INPUT = 64 * 1024 * 1024; // Base64 characters looked at all
const IMAGE_DEADLINE = "30 seconds"; // how long one image may take
const FITTED_KEEP = 4;

type Fitted = { format: string; bytes: string; note?: never } | { note: string; bytes?: never };

const mib = (n: number) => (n / (1024 * 1024)).toFixed(1) + " MB";

// an encoding to try: the format, and how to set it on an image
type Encoding = { format: string; encode: (img: Bun.Image) => Bun.Image };

// shrink tries the image's own format at Claude's size, then a lossy one
// (WebP keeps transparency, JPEG stays JPEG) smaller each time, until the
// Base64 fits.
const shrink = Effect.fnUntraced(
  function* (b64: string): Effect.fn.Return<Fitted> {
    if (typeof globalThis.Bun?.Image !== "function")
      return { note: "this plugin host can't resize images" };
    const raw = Buffer.from(b64, "base64");
    const meta = yield* Effect.tryPromise({
      try: () => new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS }).metadata(),
      catch: (e) => ({ code: codeOf(e) }),
    }).pipe(Effect.result);
    if (Result.isFailure(meta))
      return {
        note:
          meta.failure.code === "ERR_IMAGE_TOO_MANY_PIXELS"
            ? "it has too many pixels to resize"
            : "it couldn't be read as an image",
      };
    const { width, height, format } = meta.success;
    const long = Math.max(width, height);
    const jpeg = format === "jpeg";
    const own: Encoding = jpeg
      ? { format: "jpeg", encode: (img) => img.jpeg({ quality: 85 }) }
      : format === "webp"
        ? { format: "webp", encode: (img) => img.webp({ quality: 85 }) }
        : { format: "png", encode: (img) => img.png({ compressionLevel: 9 }) };
    const lossy = (quality: number): Encoding =>
      jpeg
        ? { format: "jpeg", encode: (img) => img.jpeg({ quality }) }
        : { format: "webp", encode: (img) => img.webp({ quality }) };
    const tries = [
      { edge: Math.min(long, IMAGE_EDGE), ...own },
      { edge: Math.min(long, IMAGE_EDGE), ...lossy(80) },
    ];
    for (let edge = Math.min(long, IMAGE_EDGE) * 0.7; edge >= IMAGE_MIN_EDGE; edge *= 0.7)
      tries.push({ edge: Math.round(edge), ...lossy(75) });
    for (const t of tries) {
      const out = yield* Effect.tryPromise({
        try: () => {
          let img = new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS });
          if (t.edge < long)
            img = img.resize(t.edge, t.edge, { fit: "inside", withoutEnlargement: true });
          return t.encode(img).toBase64();
        },
        catch: (e) => ({ code: codeOf(e) }),
      }).pipe(Effect.result);
      if (Result.isFailure(out)) {
        if (out.failure.code === "ERR_IMAGE_FORMAT_UNSUPPORTED") continue;
        return { note: "it couldn't be resized" };
      }
      if (out.success.length <= IMAGE_LIMIT) return { format: t.format, bytes: out.success };
    }
    return { note: "it couldn't be made small enough" };
  },
  Effect.timeoutOrElse({
    duration: IMAGE_DEADLINE,
    orElse: () => Effect.succeed({ note: "resizing it took too long" }),
  }),
  Effect.catchDefect(() => Effect.succeed({ note: "it couldn't be resized" }))
);

// Images brings every image left in a built request under Kiro's limit.
// The last few results are kept, as an image stays in the conversation and
// is sent again with the turns after it.
class Images extends Context.Service<
  Images,
  { readonly fit: (out: KiroRequest) => Effect.Effect<KiroRequest> }
>()("opencode-kiro/Images") {
  static readonly layer = Layer.sync(Images, () => {
    const fitted = new Map<string, Fitted>(); // sha256 of the Base64 → the result, newest last

    const fitOne = Effect.fnUntraced(function* (b64: string) {
      const key = createHash("sha256").update(b64).digest("hex");
      let r = fitted.get(key);
      if (r) fitted.delete(key); // kept as the newest below
      else
        r =
          b64.length > IMAGE_MAX_INPUT ? { note: "it is too large to resize" } : yield* shrink(b64);
      fitted.set(key, r);
      while (fitted.size > FITTED_KEEP) fitted.delete(fitted.keys().next().value!);
      return r;
    });

    // fit changes the request in place; an image already under the limit is sent as it is
    const fit = Effect.fn("Images.fit")(function* (out: KiroRequest) {
      const s = out.conversationState;
      const users = [
        ...(s.history ?? []).map((e) => e.userInputMessage),
        s.currentMessage.userInputMessage,
      ].filter((u): u is UserInput => !!u);
      for (const u of users) {
        if (!u.images?.length) continue;
        const kept: KiroImage[] = [];
        const notes: string[] = [];
        for (const img of u.images) {
          const b64 = img.source?.bytes;
          if (typeof b64 !== "string" || b64.length <= IMAGE_LIMIT) {
            kept.push(img);
            continue;
          }
          const r = yield* fitOne(b64);
          if (r.bytes)
            kept.push({ ...img, format: r.format, source: { ...img.source, bytes: r.bytes } });
          else
            notes.push(
              `[An image (${img.format}, ${mib(b64.length)} as Base64) was left out of this message: Kiro takes at most ${mib(IMAGE_LIMIT)} per image, and ${r.note}.]`
            );
        }
        if (kept.length) u.images = kept;
        else delete u.images;
        if (notes.length) u.content = joinNonEmpty(u.content, notes.join("\n"));
      }
      return out;
    });

    return Images.of({ fit });
  });
}

// ---- the reply: an AWS event stream → Messages ---------------------------------------

// the size of each header value type that isn't a string or bytes
const HEADER_SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

function frameHeaders(h: Uint8Array) {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let i = 0;
  while (i < h.length) {
    const n = v.getUint8(i);
    if (h.length < i + 2 + n) break;
    const name = dec.decode(h.subarray(i + 1, i + 1 + n));
    const type = v.getUint8(i + 1 + n);
    i += 2 + n;
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break;
      const l = v.getUint16(i);
      if (h.length < i + 2 + l) break;
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l));
      i += 2 + l;
      continue;
    }
    const size = HEADER_SIZES[type];
    if (size === undefined || h.length < i + size) break;
    i += size;
  }
  return out;
}

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>";
const CLOSE = "</thinking>";
function partialSuffix(s: string, tag: string) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--)
    if (s.endsWith(tag.slice(0, n))) return n;
  return 0;
}

type Said = { kind: "text" | "think"; text: string };

class ThinkParser {
  state = 0; // 0: not yet known, 1: thinking, 2: text
  buf = "";
  said = false;
  feed(s: string): Said[] {
    this.buf += s;
    const out: Said[] = [];
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, "");
        if (t.startsWith(OPEN)) {
          [this.buf, this.state] = [t.slice(OPEN.length), 1];
          continue;
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out; // may yet be the tag
        this.state = 2;
        continue;
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, "");
          if (!this.buf) return out;
        }
        const i = this.buf.indexOf(CLOSE);
        if (i !== -1) {
          if (i > 0) {
            out.push({ kind: "think", text: this.buf.slice(0, i) });
            this.said = true;
          }
          [this.buf, this.state] = [this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, ""), 2];
          continue;
        }
        // hold back what may be the start of the closing tag
        const n = this.buf.length - partialSuffix(this.buf, CLOSE);
        if (n > 0) {
          out.push({ kind: "think", text: this.buf.slice(0, n) });
          [this.buf, this.said] = [this.buf.slice(n), true];
        }
        return out;
      }
      if (this.buf) out.push({ kind: "text", text: this.buf });
      this.buf = "";
      return out;
    }
  }
  end(): Said[] {
    if (!this.buf) return [];
    const ev: Said = { kind: this.state === 1 ? "think" : "text", text: this.buf };
    this.buf = "";
    if (this.state === 0) this.state = 2;
    return [ev];
  }
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reported: boolean; // Kiro sent token counts
  credits: number; // what the reply cost, from its meteringEvents
}

// KiroEvent is a piece of Kiro's reply, as reply turns it into Messages events.
type KiroEvent =
  | Said
  | { kind: "sig" | "toolArgs"; text: string }
  | { kind: "toolStart"; id: string; name: string }
  | ({ kind: "error" } & Failure.Failure)
  | { kind: "stop"; reason: string; usage: Usage };

// what the payload of each event Kiro sends may hold
const count = field(Schema.Number);
const Payload = Schema.Struct({
  content: Schema.optional(Schema.Unknown),
  text: field(Schema.String),
  signature: field(Schema.String),
  toolUseId: field(Schema.String),
  name: field(Schema.String),
  input: Schema.optional(Schema.Unknown),
  stopReason: field(Schema.String),
  contextUsagePercentage: count,
  usage: count, // a meteringEvent's credits
  tokenUsage: field(
    Schema.Struct({
      uncachedInputTokens: count,
      inputTokens: count,
      outputTokens: count,
      cacheReadInputTokens: count,
      cacheWriteInputTokens: count,
      contextUsagePercentage: count,
    })
  ),
});
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));

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
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reported: false,
    credits: 0,
  };
  private pct = 0;
  private said = 0;
  private failed: Failure.Failure | undefined;
  private ended = false;

  constructor(
    private readonly window: number, // the model's context, to reckon the input from
    private readonly budget: number | undefined // the thinking budget the prompt set
  ) {}

  // done is whether the reply has failed, so no more of it need be read
  get done() {
    return this.failed !== undefined;
  }

  // push reads a piece of the body: the events of each message it completes.
  push(chunk: Uint8Array): KiroEvent[] {
    const out: KiroEvent[] = [];
    const n = new Uint8Array(this.buf.length + chunk.length);
    n.set(this.buf);
    n.set(chunk, this.buf.length);
    this.buf = n;
    while (!this.failed && this.buf.length >= 12) {
      const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = v.getUint32(0);
      const hlen = v.getUint32(4);
      if (total < 16 || total > 16 << 20 || hlen > total - 16) {
        this.broke("its event stream was malformed");
        break;
      }
      if (this.buf.length < total) break;
      const rest = this.buf.subarray(12, total);
      this.message(frameHeaders(rest.subarray(0, hlen)), rest.subarray(hlen, -4), out);
      this.buf = this.buf.slice(total);
    }
    return out;
  }

  // broke is the body failing before its end
  broke(message: string) {
    this.fail(Failure.brokeOff(message));
  }

  // fail is the reply failing: the first failure is the one said
  fail(f: Failure.Failure) {
    this.failed ??= f;
  }

  // end is what is left once the body is read: the rest of the text, then
  // why it stopped, or the failure.
  end(): KiroEvent[] {
    if (this.ended) return [];
    this.ended = true;
    if (this.buf.length) this.broke("the connection closed partway through an event");
    const out: KiroEvent[] = this.think.end();
    if (this.failed) {
      out.push({ kind: "error", ...this.failed });
      return out;
    }
    const usage = this.usage;
    // Kiro says how full the context is rather than how many tokens
    if (!usage.input && this.pct > 0 && this.window > 0)
      usage.input = Math.floor((this.pct / 100) * this.window);
    if (!usage.output) usage.output = Math.floor((this.said + 3) / 4);
    let reason = "end_turn";
    if (this.tools > 0) reason = "tool_use";
    else if (/^max_tokens$/i.test(this.stop)) reason = "max_tokens";
    else if (/^content_filtered$/i.test(this.stop)) reason = "refusal";
    out.push({ kind: "stop", reason, usage });
    return out;
  }

  private message(headers: Record<string, string>, payload: Uint8Array, out: KiroEvent[]) {
    const type = headers[":message-type"];
    if (type === "exception" || type === "error") {
      this.failed = Failure.fromException(
        headers[":exception-type"] || headers[":error-code"],
        new TextDecoder().decode(payload)
      );
      return;
    }
    const kind = headers[":event-type"];
    if (kind && FAILURE_EVENTS.has(kind)) {
      this.failed = Failure.fromException(kind, new TextDecoder().decode(payload));
      return;
    }
    const m = Option.getOrUndefined(decodePayload(new TextDecoder().decode(payload)));
    if (!m) return;
    if (kind === "assistantResponseEvent") {
      const text = typeof m.content === "string" ? m.content : "";
      this.said += text.length;
      if (this.budget) out.push(...this.think.feed(text));
      else if (text) out.push({ kind: "text", text });
    } else if (kind === "reasoningContentEvent") {
      if (m.text) {
        this.said += m.text.length;
        out.push({ kind: "think", text: m.text });
      } else if (m.signature) out.push({ kind: "sig", text: m.signature });
    } else if (kind === "toolUseEvent") {
      if (m.toolUseId && m.toolUseId !== this.tool) {
        out.push(...this.think.end()); // the text before a call is all said
        this.tool = m.toolUseId;
        this.tools++;
        out.push({ kind: "toolStart", id: m.toolUseId, name: m.name ?? "" });
      }
      if (m.input !== undefined && m.input !== null) {
        if (typeof m.input === "string") {
          if (m.input) out.push({ kind: "toolArgs", text: m.input });
          this.said += m.input.length;
        } else {
          const s = JSON.stringify(m.input);
          if (s !== "{}") out.push({ kind: "toolArgs", text: s });
          this.said += s.length;
        }
      }
    } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
      if (m.stopReason) this.stop = m.stopReason;
      const tu = m.tokenUsage;
      if (tu) {
        const usage = this.usage;
        usage.reported = true;
        usage.input += tu.uncachedInputTokens || tu.inputTokens || 0;
        usage.output += tu.outputTokens || 0;
        usage.cacheRead += tu.cacheReadInputTokens || 0;
        usage.cacheWrite += tu.cacheWriteInputTokens || 0;
        if (tu.contextUsagePercentage && tu.contextUsagePercentage > 0)
          this.pct = tu.contextUsagePercentage;
      }
    } else if (kind === "contextUsageEvent") {
      if (m.contextUsagePercentage && m.contextUsagePercentage > 0)
        this.pct = m.contextUsagePercentage;
    } else if (kind === "meteringEvent" && m.usage && m.usage > 0) {
      this.usage.credits += m.usage;
    }
  }
}

// events is Kiro's reply body as events. However the body ends, the last
// event says how: a stop, or an error. A body that sends nothing for
// idleSeconds, before its first event or between two, ends in a stall.
const events = (
  body: Stream.Stream<Uint8Array, unknown>,
  window: number,
  budget: number | undefined,
  idleSeconds = IDLE_SECONDS
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
        reader.fail(Failure.fromBody(cause, idleSeconds));
        return Stream.empty;
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(reader.end())))
    );
  });

// anthropicUsage is the usage in Messages' words. Without counts from Kiro
// the input is reckoned from how full the context is, and the cache fields,
// unknown, are left out.
const anthropicUsage = (u: Usage) =>
  u.reported
    ? {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite,
      }
    : { input_tokens: u.input, output_tokens: u.output };

// MessagesEncoder writes Kiro's events as Anthropic's SSE events. names
// gives back the caller's name for a tool Kiro was sent under another
// (toolNames).
class MessagesEncoder {
  private readonly id = "msg_" + randomBytes(12).toString("hex");
  private readonly enc = new TextEncoder();
  private index = -1;
  private open = ""; // the kind of block open
  private started = false;

  constructor(
    private readonly model: string,
    private readonly names: Map<string, string>
  ) {}

  encode(e: KiroEvent): Uint8Array[] {
    const out: Uint8Array[] = [];
    const sse = (type: string, data: object) =>
      out.push(this.enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
    const close = () => {
      if (this.open) sse("content_block_stop", { index: this.index });
      this.open = "";
    };
    const begin = (kind: string, block: object) => {
      close();
      this.index++;
      this.open = kind;
      sse("content_block_start", { index: this.index, content_block: block });
    };
    if (!this.started) {
      this.started = true;
      sse("message_start", {
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    const index = () => this.index;
    switch (e.kind) {
      case "text":
        if (this.open !== "text") begin("text", { type: "text", text: "" });
        sse("content_block_delta", { index: index(), delta: { type: "text_delta", text: e.text } });
        break;
      case "think":
        if (this.open !== "thinking")
          begin("thinking", { type: "thinking", thinking: "", signature: "" });
        sse("content_block_delta", {
          index: index(),
          delta: { type: "thinking_delta", thinking: e.text },
        });
        break;
      case "sig":
        if (this.open === "thinking")
          sse("content_block_delta", {
            index: index(),
            delta: { type: "signature_delta", signature: e.text },
          });
        break;
      case "toolStart":
        begin("tool", {
          type: "tool_use",
          id: e.id,
          name: this.names.get(e.name) ?? e.name,
          input: {},
        });
        break;
      case "toolArgs":
        if (this.open === "tool")
          sse("content_block_delta", {
            index: index(),
            delta: { type: "input_json_delta", partial_json: e.text },
          });
        break;
      case "error":
        close();
        sse("error", { error: Failure.toError(e) });
        break;
      case "stop":
        close();
        sse("message_delta", {
          delta: { stop_reason: e.reason, stop_sequence: null },
          usage: anthropicUsage(e.usage),
        });
        sse("message_stop", {});
        break;
    }
    return out;
  }
}

const isLast = (e: KiroEvent) => e.kind === "error" || e.kind === "stop";

// reply answers the Messages request from Kiro's events, as a stream of
// Messages events. finished is told the usage of a reply that ends well.
const reply = Effect.fnUntraced(function* (
  kiro: Stream.Stream<KiroEvent>,
  model: string,
  names: Map<string, string>,
  finished: (usage: Usage) => Effect.Effect<void>
) {
  // the first event is read before answering: an error before any of the
  // answer is a status, so OpenCode can retry it or say why. The rest of
  // the reply lives in this scope until the answer's body is read or let go.
  // Stream.peel (effect 4.0.1) drops what is left of the chunk its sink
  // ends in, so the events go one to a chunk.
  const scope = yield* Scope.make();
  const [head, rest] = yield* Stream.peel(Stream.rechunk(kiro, 1), Sink.head<KiroEvent>()).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void))
  );
  const first = Option.getOrUndefined(head);
  if (!first || first.kind === "error") {
    yield* Scope.close(scope, Exit.void);
    return Failure.toResponse(first ?? Failure.emptyReply);
  }
  const body = Stream.concat(Stream.make(first), rest).pipe(
    Stream.takeUntil(isLast),
    Stream.tap((e) => (e.kind === "stop" ? finished(e.usage) : Effect.void)),
    Stream.mapAccum(
      () => new MessagesEncoder(model, names),
      (encoder, e) => [encoder, encoder.encode(e)] as const
    ),
    Stream.ensuring(Scope.close(scope, Exit.void))
  );
  return new Response(Stream.toReadableStream(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

// ---- the plugin ------------------------------------------------------------------------

// a request that never leaves the process: what http.request sends instead
// when it can't reach Kiro, so http.response can say why
const standIn = () => new Request("data:application/json,%7B%7D", { method: "POST", body: "{}" });

// what http.response needs to turn a call's answer back, by the call
type Sent =
  | { req: MessagesRequest; model: string; thinking: Thinking; a: Auth; error?: never }
  | { error: Failure.Failure };

// Host is the part of OpenCode's plugin context this plugin uses.
type Host = {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set">;
  readonly provider: Pick<Plugin.Context["provider"], "transform" | "reload">;
  readonly session: Pick<Plugin.Context["session"], "hook">;
  readonly rpc: Pick<Plugin.Context["rpc"], "register">;
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
  const modelNamed = (id: string) =>
    Ref.get(models).pipe(Effect.map((list) => list.find((m) => m.id === id)));
  // where work outlives the request that started it: the plugin's own scope.
  // A reply's stream ends its fibers with its body.
  const scope = yield* Effect.scope;

  // the account's usage, read at most once a minute (a failure, every 10
  // seconds), and a short reason when it can't be
  const [usageCached, usageStale] = yield* Effect.cachedInvalidateWithTTL(account.usage, (exit) =>
    Exit.isSuccess(exit) ? "60 seconds" : "10 seconds"
  );
  const accountNow = usageCached.pipe(
    Effect.map((usage): { account: AccountUsage | null; error?: string } => ({ account: usage })),
    Effect.catchCause((cause) =>
      Effect.succeed({ account: null, error: Failure.fromCause(cause).message.slice(0, 200) })
    )
  );

  // the credits each session has spent: storage's, and what was added since
  const credits = new Map<string, number>();
  const creditLock = yield* Semaphore.make(1);
  const creditsOf = Effect.fnUntraced(function* (sessionID: string) {
    const known = credits.get(sessionID);
    if (known !== undefined) return known;
    const saved = Option.getOrElse(
      decodeCredits(yield* ctx.storage.get(creditsKey(sessionID))),
      () => 0
    );
    credits.set(sessionID, saved);
    return saved;
  });
  const addCredits = (sessionID: string, n: number) =>
    creditLock.withPermits(1)(
      Effect.gen(function* () {
        const total = (yield* creditsOf(sessionID)) + n;
        credits.set(sessionID, total);
        yield* ctx.storage.set(creditsKey(sessionID), total);
      })
    );

  // without the RPC the sidebar shows nothing, and Kiro still answers
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC API fails with unknown
  const registration = yield* ctx.rpc
    .register(KiroRpc, {
      usage: (input) =>
        Effect.gen(function* () {
          const { sessionIDs } = yield* decodeUsageInput(input).pipe(
            Effect.orElseSucceed(() => ({ sessionIDs: [] as readonly string[] }))
          );
          const spent: Record<string, number> = {};
          for (const id of sessionIDs) spent[id] = yield* creditsOf(id);
          const answer: UsageAnswer = { ...(yield* accountNow), credits: spent };
          return answer;
        }),
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kiro: registering the usage RPC failed", cause).pipe(
          Effect.as(undefined)
        )
      )
    );
  // telling the sidebar is best effort
  const emitUpdated = registration
    ? // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC fails with unknown
      registration.events.emit("updated", {}).pipe(Effect.ignore)
    : Effect.void;

  // after a reply, the account read again and the sidebar told. One read
  // runs at a time; a reply ending during one is in what it tells.
  const refreshing = yield* Semaphore.make(1);
  const refreshUsage = usageStale.pipe(
    Effect.andThen(accountNow),
    Effect.andThen(emitUpdated),
    Effect.ignore,
    refreshing.withPermitsIfAvailable(1)
  );
  const finished = (sessionID: string | undefined) => (usage: Usage) =>
    Effect.gen(function* () {
      if (sessionID && usage.credits > 0) yield* addCredits(sessionID, usage.credits);
      yield* refreshUsage;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kiro: counting a reply's credits failed", cause)
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    );

  const kiroBody = (req: MessagesRequest, model: string, profile: string, thinking: Thinking) =>
    images
      .fit(kiroRequest(req, model, profile, thinking))
      .pipe(Effect.map((b) => JSON.stringify(b)));

  // the provider is added again on each reload, with the models then known
  yield* ctx.provider.transform((editor) => {
    editor.add({ info: PROVIDER, models: Ref.getUnsafe(models).map(modelInfo) });
  });

  yield* ctx.session.hook(
    "http.request",
    Effect.fn("Kiro.request")(
      function* (event) {
        if (!new URL(event.request.url).pathname.endsWith("/messages")) return;
        // OpenCode's own Anthropic route wrote this body (see MessagesRequest)
        const req = (yield* Effect.tryPromise(() =>
          event.request.clone().json()
        )) as MessagesRequest;
        const model = String(req.model ?? "auto");
        const thinking = thinkingOf(req, model, yield* modelNamed(model));
        const a = yield* account.credentials();
        const call = yield* HttpClientRequest.toWeb(
          kiroCall(a, yield* kiroBody(req, model, a.profile, thinking))
        );
        sent.set(call, { req, model, thinking, a });
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
          res = yield* send(
            kiroCall(a, yield* kiroBody(p.req, p.model, a.profile, p.thinking)),
            HEADERS_SECONDS
          );
        }
        if (res.status < 200 || res.status > 299) {
          const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          event.response = Failure.toResponse(
            Failure.fromReply(res.status, body.slice(0, 1 << 20), res.headers)
          );
          return;
        }
        const window = (yield* modelNamed(p.model))?.context ?? 0;
        event.response = yield* reply(
          events(res.stream, window, p.thinking.budget),
          p.model,
          toolNames(p.req),
          finished(event.sessionID)
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
export const _internal = {
  make,
  KiroAccount,
  Images,
  modelOf,
  modelInfo,
  thinkingOf,
  kiroRequest,
  events,
  toolName,
  toolNames,
};
