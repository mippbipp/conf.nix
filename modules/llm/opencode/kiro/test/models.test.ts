// The model catalogue through src/models.ts: the thinking levels OpenCode
// offers for each model Kiro lists.

import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";

import { modelInfo, modelOf } from "../src/models.ts";

const variants = (listed: Parameters<typeof modelOf>[0]): Array<string> =>
  Arr.map(modelInfo(modelOf(listed)).variants, (variant) => variant.id);

describe("models", () => {
  it.effect(
    "each model offers the levels of the thinking Kiro lists request fields for",
    () =>
      Effect.sync(() => {
        const claude = {
          additionalModelRequestFieldsSchema: {
            properties: {
              max_tokens: { maximum: 64_000, minimum: 1024 },
              output_config: {
                properties: { effort: { enum: ["low", "high"] } },
              },
              thinking: {
                properties: {
                  display: { enum: ["summarized"] },
                  type: { enum: ["adaptive", "disabled"] },
                },
              },
            },
          },
          modelId: "claude-x",
          supportedInputTypes: ["TEXT", "IMAGE"],
          tokenLimits: { maxInputTokens: 1000, maxOutputTokens: 100 },
        };
        assert.deepStrictEqual(variants(claude), ["none", "low", "high"]);
        assert.deepStrictEqual(modelInfo(modelOf(claude)).capabilities.input, [
          "text",
          "image",
        ]);
        assert.deepStrictEqual(
          variants({
            additionalModelRequestFieldsSchema: {
              properties: {
                reasoning: {
                  properties: { effort: { enum: ["none", "low"] } },
                },
              },
            },
            modelId: "gpt-x",
          }),
          ["none", "low"]
        );
        // a model Kiro lists no fields for thinks in the prompt
        assert.deepStrictEqual(variants({ modelId: "claude-sonnet-4.5" }), [
          "low",
          "medium",
          "high",
          "max",
        ]);
      })
  );

  // Claude Code's levels are low, medium, high, xhigh and max; xhigh isn't
  // routed as max (magpie #120)
  it.effect(
    "xhigh is offered as its own level, and a model that doesn't think offers none",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          variants({
            additionalModelRequestFieldsSchema: {
              properties: {
                output_config: {
                  properties: { effort: { enum: ["high", "xhigh", "max"] } },
                },
              },
            },
            modelId: "claude-y",
          }),
          ["high", "xhigh", "max"]
        );
        assert.deepStrictEqual(variants({ modelId: "deepseek-3.2" }), []);
      })
  );
});
