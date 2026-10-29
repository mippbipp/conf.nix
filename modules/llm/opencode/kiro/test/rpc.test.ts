// The usage RPC's contract, through src/rpc.ts: what OpenCode lets through
// to the server's handler and back to the sidebar. Run with
// BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import type { StandardSchema } from "effect";

import { KiroRpc } from "../src/rpc.ts";

// what OpenCode does with a Standard Schema: the value, or why not
const check = async <A>(schema: StandardSchema.StandardSchemaV1<unknown, A>, value: unknown) =>
  schema["~standard"].validate(value);
const issues = async <A>(schema: StandardSchema.StandardSchemaV1<unknown, A>, value: unknown) =>
  (await check(schema, value)).issues ?? [];
const { usage } = KiroRpc.methods;

const ANSWER = {
  account: {
    plan: "Kiro Pro",
    resetsAt: 1793491200000,
    allowances: [
      {
        name: "Credit",
        used: 8978.62,
        limit: 1000,
        overage: {
          credits: 7978.62,
          charges: 319.14,
          currency: "USD",
          rate: 0.04,
          cap: 40000,
          enabled: true,
        },
        trial: { used: 10, limit: 500 },
      },
    ],
    checkedAt: 1793400000000,
  },
  credits: { ses_a: 0.341 },
};

test("usage's input is the session IDs", async () => {
  expect(await check(usage.input, { sessionIDs: ["ses_a"] })).toEqual({
    value: { sessionIDs: ["ses_a"] },
  });
  expect(await issues(usage.input, {})).not.toHaveLength(0);
  expect(await issues(usage.input, { sessionIDs: "ses_a" })).not.toHaveLength(0);
  expect(await issues(usage.input, { sessionIDs: [1] })).not.toHaveLength(0);
});

test("usage's answer: the account, or none and why, and each session's credits", async () => {
  expect(await check(usage.output, ANSWER)).toEqual({ value: ANSWER });
  const unread = { account: null, error: "Kiro: Not allowed (HTTP 403)", credits: {} };
  expect(await check(usage.output, unread)).toEqual({ value: unread });

  const bad = [
    { credits: {} },
    { account: null },
    { account: null, credits: { ses_a: "1" } },
    { account: null, error: 1, credits: {} },
    { ...ANSWER, account: { ...ANSWER.account, plan: undefined } },
    { ...ANSWER, account: { ...ANSWER.account, allowances: [{ name: "Credit", used: 1 }] } },
    {
      ...ANSWER,
      account: {
        ...ANSWER.account,
        allowances: [{ name: "Credit", used: 1, limit: 2, trial: { used: 1 } }],
      },
    },
  ];
  for (const answer of bad) expect(await issues(usage.output, answer)).not.toHaveLength(0);
});

test("updated carries no data", async () => {
  expect(await check(KiroRpc.events.updated.schema, {})).toEqual({ value: {} });
  expect(await issues(KiroRpc.events.updated.schema, null)).not.toHaveLength(0);
});
