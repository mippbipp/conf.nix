// The usage RPC's contract, through src/rpc.ts: what OpenCode lets through
// to the server's handler and back to the sidebar.

import { assert, describe, it } from "@effect/vitest";
import { Effect, type StandardSchema } from "effect";

import { KiroRpc } from "../src/rpc.ts";

// what OpenCode does with a Standard Schema: the value, or why not
const check = <A>(
  schema: StandardSchema.StandardSchemaV1<unknown, A>,
  value: unknown
) => Effect.promise(() => Promise.resolve(schema["~standard"].validate(value)));
const issues = <A>(
  schema: StandardSchema.StandardSchemaV1<unknown, A>,
  value: unknown
) => check(schema, value).pipe(Effect.map((result) => result.issues ?? []));
const { usage } = KiroRpc.methods;

const ANSWER = {
  account: {
    allowances: [
      {
        limit: 1000,
        name: "Credit",
        overage: {
          cap: 40_000,
          charges: 319.14,
          credits: 7978.62,
          currency: "USD",
          enabled: true,
          rate: 0.04,
        },
        trial: { limit: 500, used: 10 },
        used: 8978.62,
      },
    ],
    checkedAt: 1_793_400_000_000,
    plan: "Kiro Pro",
    resetsAt: 1_793_491_200_000,
  },
  credits: { ses_a: 0.341 },
};

describe("the usage RPC", () => {
  it.effect("usage's input is the session IDs", () =>
    Effect.gen(function* () {
      const checked = yield* check(usage.input, { sessionIDs: ["ses_a"] });
      assert.deepStrictEqual(checked, { value: { sessionIDs: ["ses_a"] } });
      const found = yield* issues(usage.input, {});
      assert.isNotEmpty(found);
      const found2 = yield* issues(usage.input, { sessionIDs: "ses_a" });
      assert.isNotEmpty(found2);
      const found3 = yield* issues(usage.input, { sessionIDs: [1] });
      assert.isNotEmpty(found3);
    })
  );

  it.effect(
    "usage's answer: the account, or none and why, and each session's credits",
    () =>
      Effect.gen(function* () {
        const checked = yield* check(usage.output, ANSWER);
        assert.deepStrictEqual(checked, {
          value: ANSWER,
        });
        const unread = {
          account: null,
          credits: {},
          error: "Kiro: Not allowed (HTTP 403)",
        };
        const checked2 = yield* check(usage.output, unread);
        assert.deepStrictEqual(checked2, {
          value: unread,
        });

        const bad = [
          { credits: {} },
          { account: null },
          { account: null, credits: { ses_a: "1" } },
          { account: null, credits: {}, error: 1 },
          { ...ANSWER, account: { ...ANSWER.account, plan: undefined } },
          {
            ...ANSWER,
            account: {
              ...ANSWER.account,
              allowances: [{ name: "Credit", used: 1 }],
            },
          },
          {
            ...ANSWER,
            account: {
              ...ANSWER.account,
              allowances: [
                { limit: 2, name: "Credit", trial: { used: 1 }, used: 1 },
              ],
            },
          },
        ];
        for (const answer of bad) {
          const found = yield* issues(usage.output, answer);
          assert.isNotEmpty(found);
        }
      })
  );

  it.effect("updated carries no data", () =>
    Effect.gen(function* () {
      const checked = yield* check(KiroRpc.events.updated.schema, {});
      assert.deepStrictEqual(checked, {
        value: {},
      });
      const found = yield* issues(KiroRpc.events.updated.schema, null);
      assert.isNotEmpty(found);
    })
  );
});
