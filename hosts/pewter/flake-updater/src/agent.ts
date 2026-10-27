import type { Effect, Option } from "effect";
import { Context, Schema } from "effect";

import type { RepairReport } from "./report.ts";

export class AgentError extends Schema.TaggedError<
  AgentError,
  { readonly brand: unique symbol }
>()("AgentError", {
  /** `unavailable`: the server, agent or model could not run at all. */
  reason: Schema.Literals(["unavailable", "failed"]),
  message: Schema.String,
  /** The session the failure happened in, when one was opened. */
  session: Schema.optionalKey(Schema.String),
}) {}

export interface RepairRequest {
  /** Continue this session; a new one is created on the first round. */
  readonly session: Option.Option<string>;
  readonly title: string;
  readonly round: number;
  readonly pr: number;
  /** Trimmed failing-check output. */
  readonly failures: string;
  /** `name old→new` lines for every input the update changed. */
  readonly changes: string;
  readonly mainLock: string;
  /** Why the Updater discarded the previous round, if it did. */
  readonly feedback: Option.Option<string>;
}

export interface RepairResult {
  readonly session: string;
  readonly report: RepairReport;
}

/** The Flake fixer: an opencode agent editing a copy of the branch. */
export class Agent extends Context.Service<
  Agent,
  {
    readonly repair: (
      request: RepairRequest
    ) => Effect.Effect<RepairResult, AgentError>;
  }
>()("flake-updater/agent") {}
