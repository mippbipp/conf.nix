// The model catalogue: the models Kiro lists for the account, how each
// thinks, and how OpenCode's catalog holds them.

import type { Model, Provider } from "@opencode/plugin/effect";
import { Schema } from "effect";

import { field, ID } from "./kiro.ts";

// Each model Kiro lists says which request fields it takes for thinking
// (additionalModelRequestFieldsSchema): Claude 4.6 and later take Anthropic's
// adaptive thinking with an effort, GPT takes a reasoning effort. Models it
// lists none for (Auto, Claude 4.5) are asked to think in the prompt, with a
// budget, as kiro-cli asked before the fields existed.
export const BUDGETS: Record<string, number> = {
  low: 10000,
  medium: 20000,
  high: 30000,
  xhigh: 50000,
  max: 50000,
};
const PROMPT_EFFORTS = ["low", "medium", "high", "max"];
export const thinks = (id: string) => /claude/i.test(id) || id === "auto";

// KiroModel is a model as Kiro lists it, kept in the plugin's storage
// between runs. fields is the request fields it takes for thinking:
// Anthropic's, OpenAI's, or none.
export const KiroModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context: Schema.Number,
  output: Schema.Number,
  images: Schema.Boolean,
  fields: Schema.Literals(["claude", "openai", ""]),
  efforts: Schema.Array(Schema.String),
  off: Schema.optional(Schema.Boolean), // thinking can be turned off
  summarized: Schema.optional(Schema.Boolean), // the thinking can be summarized
  maxTokens: Schema.optional(Schema.Tuple([Schema.Number, Schema.Number])),
});
export type KiroModel = typeof KiroModel.Type;

// a list saved by an earlier run, if it still reads as one
export const decodeSaved = Schema.decodeUnknownOption(Schema.NonEmptyArray(KiroModel));

// until Kiro has listed the account's models: Auto, which picks one for each request
export const FALLBACK: readonly KiroModel[] = [
  {
    id: "auto",
    name: "Auto",
    context: 200000,
    output: 64000,
    images: true,
    fields: "",
    efforts: [],
  },
];

// a JSON schema's enum, as a model's request fields give one
const Enum = field(Schema.Struct({ enum: field(Schema.Array(Schema.Unknown)) }));

// a model as List-Available-Models gives it
const ListedModel = Schema.Struct({
  modelId: Schema.String,
  modelName: field(Schema.String),
  tokenLimits: field(
    Schema.Struct({ maxInputTokens: field(Schema.Number), maxOutputTokens: field(Schema.Number) })
  ),
  supportedInputTypes: field(Schema.Array(Schema.Unknown)),
  additionalModelRequestFieldsSchema: field(
    Schema.Struct({
      properties: field(
        Schema.Struct({
          thinking: field(
            Schema.Struct({ properties: field(Schema.Struct({ type: Enum, display: Enum })) })
          ),
          output_config: field(
            Schema.Struct({ properties: field(Schema.Struct({ effort: Enum })) })
          ),
          reasoning: field(Schema.Struct({ properties: field(Schema.Struct({ effort: Enum })) })),
          max_tokens: field(
            Schema.Struct({ minimum: field(Schema.Number), maximum: field(Schema.Number) })
          ),
        })
      ),
    })
  ),
});
type ListedModel = typeof ListedModel.Type;
export const decodeListedModel = Schema.decodeUnknownOption(ListedModel);

export function modelOf(m: ListedModel): KiroModel {
  const fields = m.additionalModelRequestFieldsSchema?.properties ?? {};
  const thinking = fields.thinking?.properties ?? {};
  const style = fields.output_config ? "claude" : fields.reasoning ? "openai" : "";
  const efforts =
    (style === "claude"
      ? fields.output_config?.properties?.effort?.enum
      : fields.reasoning?.properties?.effort?.enum) ?? [];
  const maxTokens = fields.max_tokens;
  let name = m.modelName;
  if (!name || name === m.modelId) name = m.modelId === "auto" ? "Auto" : m.modelId;
  return {
    id: m.modelId,
    name,
    context: m.tokenLimits?.maxInputTokens ?? 0,
    output: m.tokenLimits?.maxOutputTokens ?? 0,
    images: (m.supportedInputTypes ?? []).some((t) => String(t).toUpperCase() === "IMAGE"),
    fields: style,
    efforts: efforts.filter((e): e is string => typeof e === "string"),
    off: (thinking.type?.enum ?? []).includes("disabled"),
    summarized: (thinking.display?.enum ?? []).includes("summarized"),
    ...(maxTokens?.maximum && maxTokens.maximum > 0
      ? { maxTokens: [maxTokens.minimum ?? 1, maxTokens.maximum] as const }
      : {}),
  };
}

function variantsOf(m: KiroModel): Model.Variant[] {
  let levels: readonly string[] = [];
  if (m.fields === "claude") levels = [...(m.off ? ["none"] : []), ...m.efforts];
  else if (m.fields === "openai") levels = m.efforts;
  else if (thinks(m.id)) levels = PROMPT_EFFORTS;
  // each level reaches http.request as the body's output_config.effort
  return levels.map((effort) => ({ id: effort as Model.VariantID, settings: { effort } }));
}

// modelInfo is a model as OpenCode's catalog holds it.
export function modelInfo(m: KiroModel): Model.Info {
  return {
    id: m.id as Model.ID,
    modelID: m.id as Model.ID,
    providerID: ID as Provider.ID,
    name: m.name,
    capabilities: { tools: true, input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
    variants: variantsOf(m),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: m.context || 200000, output: m.output || 32000 },
    // the Anthropic route would send these for Claude 5 by its model id; Kiro takes neither
    compatibility: { supportsEffortUpdates: false, supportsThinkingBlockBinding: false },
  };
}
