// The model catalogue through src/models.ts: the thinking levels OpenCode
// offers for each model Kiro lists. Run with BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import { Array as Arr } from "effect";

import { modelInfo, modelOf } from "../src/models.ts";

const variants = (listed: Parameters<typeof modelOf>[0]): string[] =>
  Arr.map(modelInfo(modelOf(listed)).variants, (variant) => variant.id);

test("each model offers the levels of the thinking Kiro lists request fields for", () => {
  const claude = {
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
        max_tokens: { minimum: 1024, maximum: 64_000 },
      },
    },
  };
  expect(variants(claude)).toEqual(["none", "low", "high"]);
  expect(modelInfo(modelOf(claude)).capabilities.input).toEqual(["text", "image"]);
  expect(
    variants({
      modelId: "gpt-x",
      additionalModelRequestFieldsSchema: {
        properties: { reasoning: { properties: { effort: { enum: ["none", "low"] } } } },
      },
    })
  ).toEqual(["none", "low"]);
  // a model Kiro lists no fields for thinks in the prompt
  expect(variants({ modelId: "claude-sonnet-4.5" })).toEqual(["low", "medium", "high", "max"]);
});

// Claude Code's levels are low, medium, high, xhigh and max; xhigh isn't
// routed as max (magpie #120)
test("xhigh is offered as its own level, and a model that doesn't think offers none", () => {
  expect(
    variants({
      modelId: "claude-y",
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["high", "xhigh", "max"] } } },
        },
      },
    })
  ).toEqual(["high", "xhigh", "max"]);
  expect(variants({ modelId: "deepseek-3.2" })).toEqual([]);
});
