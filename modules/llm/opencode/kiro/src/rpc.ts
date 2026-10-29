// The Kiro plugin's RPC, between its server part (index.ts) and its sidebar
// (tui.tsx). The Effect Schemas here are the whole contract: Rpc.define takes
// them as Standard Schemas, which OpenCode checks calls against and types
// both ends by.

import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";

// an allowance is one kind of usage the account has a limit for, credits today
const Allowance = Schema.Struct({
  name: Schema.String,
  used: Schema.Finite,
  limit: Schema.Finite,
  // what went over the limit, at the overage rate, when the account allows it
  overage: Schema.optional(
    Schema.Struct({
      credits: Schema.Finite,
      charges: Schema.Finite,
      currency: Schema.String,
      rate: Schema.Finite,
      cap: Schema.Finite,
      enabled: Schema.Boolean,
    })
  ),
  // a free trial still running, with its own limit
  trial: Schema.optional(
    Schema.Struct({
      used: Schema.Finite,
      limit: Schema.Finite,
      expiresAt: Schema.optional(Schema.Finite),
    })
  ),
});
export const AccountUsage = Schema.Struct({
  plan: Schema.String,
  resetsAt: Schema.Finite, // epoch ms, 0 when unknown
  allowances: Schema.Array(Allowance),
  checkedAt: Schema.Finite, // epoch ms
});
export const UsageAnswer = Schema.Struct({
  account: Schema.NullOr(AccountUsage),
  error: Schema.optional(Schema.String),
  credits: Schema.Record(Schema.String, Schema.Finite),
});
export type AccountUsage = typeof AccountUsage.Type;
export type Allowance = typeof Allowance.Type;
export type UsageAnswer = typeof UsageAnswer.Type;

export const KiroRpc = Rpc.define({
  id: "kiro",
  methods: {
    // usage is the account's usage this month, and the credits each session
    // asked for has spent. error says why the account couldn't be read.
    usage: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })),
      output: Schema.toStandardSchemaV1(UsageAnswer),
    },
  },
  events: {
    // the account or a session's credits changed: ask for usage again
    updated: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) },
  },
});
