// The Kiro plugin's RPC, between its server part (index.ts) and its sidebar
// (tui.tsx). OpenCode checks calls against its JSON Schema; UsageAnswer is
// the same answer in Effect's words, which index.ts builds and tui.tsx reads.
import { Schema } from "effect";
import { Rpc } from "@opencode/plugin/rpc";

const Allowance = Schema.Struct({
  name: Schema.String,
  used: Schema.Number,
  limit: Schema.Number,
  overage: Schema.optional(
    Schema.Struct({
      credits: Schema.Number,
      charges: Schema.Number,
      currency: Schema.String,
      rate: Schema.Number,
      cap: Schema.Number,
      enabled: Schema.Boolean,
    }),
  ),
  trial: Schema.optional(
    Schema.Struct({
      used: Schema.Number,
      limit: Schema.Number,
      expiresAt: Schema.optional(Schema.Number),
    }),
  ),
});
export const AccountUsage = Schema.Struct({
  plan: Schema.String,
  resetsAt: Schema.Number,
  allowances: Schema.Array(Allowance),
  checkedAt: Schema.Number,
});
export const UsageAnswer = Schema.Struct({
  account: Schema.NullOr(AccountUsage),
  error: Schema.optional(Schema.String),
  credits: Schema.Record(Schema.String, Schema.Number),
});
export type AccountUsage = typeof AccountUsage.Type;
export type Allowance = typeof Allowance.Type;
export type UsageAnswer = typeof UsageAnswer.Type;

const number = { type: "number" } as const;

// an allowance is one kind of usage the account has a limit for, credits today
const allowance = {
  type: "object",
  properties: {
    name: { type: "string" },
    used: number,
    limit: number,
    // what went over the limit, at the overage rate, when the account allows it
    overage: {
      type: "object",
      properties: {
        credits: number,
        charges: number,
        currency: { type: "string" },
        rate: number,
        cap: number,
        enabled: { type: "boolean" },
      },
      required: ["credits", "charges", "currency", "rate", "cap", "enabled"],
      additionalProperties: false,
    },
    // a free trial still running, with its own limit
    trial: {
      type: "object",
      properties: { used: number, limit: number, expiresAt: number },
      required: ["used", "limit"],
      additionalProperties: false,
    },
  },
  required: ["name", "used", "limit"],
  additionalProperties: false,
} as const;

export const KiroRpc = Rpc.define({
  id: "kiro",
  methods: {
    // usage is the account's usage this month, and the credits each session
    // asked for has spent. error says why the account couldn't be read.
    usage: {
      input: {
        type: "object",
        properties: { sessionIDs: { type: "array", items: { type: "string" } } },
        required: ["sessionIDs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          account: {
            anyOf: [
              {
                type: "object",
                properties: {
                  plan: { type: "string" },
                  resetsAt: number, // epoch ms, 0 when unknown
                  allowances: { type: "array", items: allowance },
                  checkedAt: number, // epoch ms
                },
                required: ["plan", "resetsAt", "allowances", "checkedAt"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
          error: { type: "string" },
          credits: { type: "object", additionalProperties: number },
        },
        required: ["account", "credits"],
        additionalProperties: false,
      },
    },
  },
  events: {
    // the account or a session's credits changed: ask for usage again
    updated: { schema: { type: "object", additionalProperties: false } },
  },
});
