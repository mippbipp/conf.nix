// The model catalogue: the models Kiro lists for the account, how each
// thinks, and how OpenCode's catalog holds them.

import type { Model, Provider } from "@opencode/plugin/effect";
import { Array as Arr, Predicate, Schema, String as Str } from "effect";

import { field, ID } from "./kiro.ts";

// Each model Kiro lists says which request fields it takes for thinking
// (additionalModelRequestFieldsSchema): Claude 4.6 and later take Anthropic's
// adaptive thinking with an effort, GPT takes a reasoning effort. Models it
// lists none for (Auto, Claude 4.5) are asked to think in the prompt, with a
// budget, as kiro-cli asked before the fields existed.
export const BUDGETS = new Map([
  ["low", 10_000],
  ["medium", 20_000],
  ["high", 30_000],
  ["xhigh", 50_000],
  ["max", 50_000],
]);
const PROMPT_EFFORTS = ["low", "medium", "high", "max"];
export const thinks = (id: string) => /claude/i.test(id) || id === "auto";

// KiroModel is a model as Kiro lists it, kept in the plugin's storage
// between runs. fields is the request fields it takes for thinking:
// Anthropic's, OpenAI's, or none.
export const KiroModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context: Schema.Finite,
  output: Schema.Finite,
  images: Schema.Boolean,
  fields: Schema.Literals(["claude", "openai", ""]),
  efforts: Schema.Array(Schema.String),
  off: Schema.optional(Schema.Boolean), // thinking can be turned off
  summarized: Schema.optional(Schema.Boolean), // the thinking can be summarized
  maxTokens: Schema.optional(Schema.Tuple([Schema.Finite, Schema.Finite])),
});
export type KiroModel = typeof KiroModel.Type;

// a list saved by an earlier run, if it still reads as one
export const decodeSaved = Schema.decodeUnknownOption(Schema.NonEmptyArray(KiroModel));
// whether two lists hold the same models, in the same order
export const sameModels = Schema.toEquivalence(Schema.Array(KiroModel));

// until Kiro has listed the account's models: Auto, which picks one for each request
export const FALLBACK: readonly KiroModel[] = [
  {
    id: "auto",
    name: "Auto",
    context: 200_000,
    output: 64_000,
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
    Schema.Struct({ maxInputTokens: field(Schema.Finite), maxOutputTokens: field(Schema.Finite) })
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
            Schema.Struct({ minimum: field(Schema.Finite), maximum: field(Schema.Finite) })
          ),
        })
      ),
    })
  ),
});
type ListedModel = typeof ListedModel.Type;
export const decodeListedModel = Schema.decodeUnknownOption(ListedModel);

type Fields = NonNullable<
  NonNullable<ListedModel["additionalModelRequestFieldsSchema"]>["properties"]
>;

// thinkingOf is how a listed model takes thinking: the style of its
// request fields, the efforts it takes, and whether thinking can be turned
// off or summarized
function thinkingOf(fields: Fields): Pick<KiroModel, "fields" | "efforts" | "off" | "summarized"> {
  const thinking = fields.thinking?.properties ?? {};
  const style = fields.output_config ? "claude" : fields.reasoning ? "openai" : "";
  const efforts =
    (style === "claude"
      ? fields.output_config?.properties?.effort?.enum
      : fields.reasoning?.properties?.effort?.enum) ?? [];
  return {
    fields: style,
    efforts: Arr.filter(efforts, Predicate.isString),
    off: (thinking.type?.enum ?? []).includes("disabled"),
    summarized: (thinking.display?.enum ?? []).includes("summarized"),
  };
}

export function modelOf(listed: ListedModel): KiroModel {
  const fields = listed.additionalModelRequestFieldsSchema?.properties ?? {};
  const maxTokens = fields.max_tokens;
  let name = listed.modelName;
  if (!name || name === listed.modelId) name = listed.modelId === "auto" ? "Auto" : listed.modelId;
  return {
    id: listed.modelId,
    name,
    context: listed.tokenLimits?.maxInputTokens ?? 0,
    output: listed.tokenLimits?.maxOutputTokens ?? 0,
    images: Arr.some(
      listed.supportedInputTypes ?? [],
      (type) => Str.toUpperCase(String(type)) === "IMAGE"
    ),
    ...thinkingOf(fields),
    ...(maxTokens?.maximum && maxTokens.maximum > 0
      ? { maxTokens: [maxTokens.minimum ?? 1, maxTokens.maximum] as const }
      : {}),
  };
}

function variantsOf(model: KiroModel): Model.Variant[] {
  let levels: readonly string[] = [];
  if (model.fields === "claude") levels = [...(model.off ? ["none"] : []), ...model.efforts];
  else if (model.fields === "openai") levels = model.efforts;
  else if (thinks(model.id)) levels = PROMPT_EFFORTS;
  // each level reaches http.request as the body's output_config.effort
  return Arr.map(levels, (effort) => ({
    // SAFETY: a variant's id is any string the provider picks; OpenCode brands it
    id: effort as Model.VariantID,
    settings: { effort },
  }));
}

// modelInfo is a model as OpenCode's catalog holds it.
export function modelInfo(model: KiroModel): Model.Info {
  // SAFETY: OpenCode's IDs are branded strings; a model's is the id Kiro
  // lists, and the provider's is this plugin's ID
  return {
    id: model.id as Model.ID,
    modelID: model.id as Model.ID,
    providerID: ID as Provider.ID,
    name: model.name,
    capabilities: {
      tools: true,
      input: model.images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: variantsOf(model),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context || 200_000, output: model.output || 32_000 },
    // the Anthropic route would send these for Claude 5 by its model id; Kiro takes neither
    compatibility: { supportsEffortUpdates: false, supportsThinkingBlockBinding: false },
  };
}
