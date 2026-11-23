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
export const thinks = (id: string) => /claude/iu.test(id) || id === "auto";

// KiroModel is a model as Kiro lists it, kept in the plugin's storage
// between runs. fields is the request fields it takes for thinking:
// Anthropic's, OpenAI's, or none.
export const KiroModel = Schema.Struct({
  context: Schema.Finite,
  efforts: Schema.Array(Schema.String),
  fields: Schema.Literals(["claude", "openai", ""]),
  id: Schema.String,
  images: Schema.Boolean,
  maxTokens: Schema.optional(Schema.Tuple([Schema.Finite, Schema.Finite])),
  name: Schema.String,
  off: Schema.optional(Schema.Boolean), // thinking can be turned off
  output: Schema.Finite,
  summarized: Schema.optional(Schema.Boolean), // the thinking can be summarized
});
export type KiroModel = typeof KiroModel.Type;

// a list saved by an earlier run, if it still reads as one
export const decodeSaved = Schema.decodeUnknownOption(
  Schema.NonEmptyArray(KiroModel)
);
// whether two lists hold the same models, in the same order
export const sameModels = Schema.toEquivalence(Schema.Array(KiroModel));

// until Kiro has listed the account's models: Auto, which picks one for each request
export const FALLBACK: ReadonlyArray<KiroModel> = [
  {
    context: 200_000,
    efforts: [],
    fields: "",
    id: "auto",
    images: true,
    name: "Auto",
    output: 64_000,
  },
];

// a JSON schema's enum, as a model's request fields give one
const Values = Schema.Array(Schema.Unknown);
const Enum = field(Schema.Struct({ enum: field(Values) }));
// a JSON schema object's properties, as a model's request fields give them
const withProperties = <F extends Schema.Struct.Fields>(fields: F) => {
  const properties = field(Schema.Struct(fields));
  return field(Schema.Struct({ properties }));
};

const MaxTokens = Schema.Struct({
  maximum: field(Schema.Finite),
  minimum: field(Schema.Finite),
});
const RequestFields = Schema.Struct({
  max_tokens: field(MaxTokens),
  output_config: withProperties({ effort: Enum }),
  reasoning: withProperties({ effort: Enum }),
  thinking: withProperties({ display: Enum, type: Enum }),
});
const TokenLimits = Schema.Struct({
  maxInputTokens: field(Schema.Finite),
  maxOutputTokens: field(Schema.Finite),
});

// the JSON schema of the request fields a model takes
const RequestFieldsSchema = Schema.Struct({ properties: field(RequestFields) });

// a model as List-Available-Models gives it
const ListedModel = Schema.Struct({
  additionalModelRequestFieldsSchema: field(RequestFieldsSchema),
  modelId: Schema.String,
  modelName: field(Schema.String),
  supportedInputTypes: field(Schema.Array(Schema.Unknown)),
  tokenLimits: field(TokenLimits),
});
type ListedModel = typeof ListedModel.Type;
export const decodeListedModel = Schema.decodeUnknownOption(ListedModel);

type Fields = NonNullable<
  NonNullable<ListedModel["additionalModelRequestFieldsSchema"]>["properties"]
>;

// thinkingOf is how a listed model takes thinking: the style of its
// request fields, the efforts it takes, and whether thinking can be turned
// off or summarized
function thinkingOf(
  fields: Fields
): Pick<KiroModel, "fields" | "efforts" | "off" | "summarized"> {
  const thinking = fields.thinking?.properties ?? {};
  const style = Predicate.isNotNullish(fields.output_config)
    ? "claude"
    : Predicate.isNotNullish(fields.reasoning)
      ? "openai"
      : "";
  const efforts =
    (style === "claude"
      ? fields.output_config?.properties?.effort?.enum
      : fields.reasoning?.properties?.effort?.enum) ?? [];
  return {
    efforts: Arr.filter(efforts, Predicate.isString),
    fields: style,
    off: (thinking.type?.enum ?? []).includes("disabled"),
    summarized: (thinking.display?.enum ?? []).includes("summarized"),
  };
}

export function modelOf(listed: ListedModel): KiroModel {
  const fields = listed.additionalModelRequestFieldsSchema?.properties ?? {};
  const maxTokens = fields.max_tokens;
  let name = listed.modelName ?? "";
  if (name === "" || name === listed.modelId) {
    name = listed.modelId === "auto" ? "Auto" : listed.modelId;
  }
  const model: KiroModel = {
    context: listed.tokenLimits?.maxInputTokens ?? 0,
    id: listed.modelId,
    images: Arr.some(
      listed.supportedInputTypes ?? [],
      (type) => Str.toUpperCase(String(type)) === "IMAGE"
    ),
    name,
    output: listed.tokenLimits?.maxOutputTokens ?? 0,
    ...thinkingOf(fields),
  };
  const maximum = maxTokens?.maximum ?? 0;
  return maximum > 0
    ? { ...model, maxTokens: [maxTokens?.minimum ?? 1, maximum] }
    : model;
}

function variantsOf(model: KiroModel): Array<Model.Variant> {
  let levels: ReadonlyArray<string> = [];
  if (model.fields === "claude") {
    levels = [...(model.off === true ? ["none"] : []), ...model.efforts];
  } else if (model.fields === "openai") {
    levels = model.efforts;
  } else if (thinks(model.id)) {
    levels = PROMPT_EFFORTS;
  }
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
    capabilities: {
      input: model.images ? ["text", "image"] : ["text"],
      output: ["text"],
      tools: true,
    },
    cost: [],
    enabled: true,
    id: model.id as Model.ID,
    limit: {
      context: model.context || 200_000,
      output: model.output || 32_000,
    },
    modelID: model.id as Model.ID,
    name: model.name,
    providerID: ID as Provider.ID,
    status: "active",
    time: { released: 0 },
    variants: variantsOf(model),
    // the Anthropic route would send these for Claude 5 by its model id; Kiro takes neither
    compatibility: {
      supportsEffortUpdates: false,
      supportsThinkingBlockBinding: false,
    },
  };
}
