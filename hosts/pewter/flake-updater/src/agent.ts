import type { Effect, Option } from "effect";
import { Context, Schema } from "effect";

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

/** What the Flake fixer says it did in one round. */
export class RepairReport extends Schema.Class<
  RepairReport,
  { readonly brand: unique symbol }
>("RepairReport")({
  outcome: Schema.Literals(["fixed", "reverted", "gave-up"]),
  revertedInputs: Schema.Array(Schema.String),
  filesChanged: Schema.Array(Schema.String),
  summary: Schema.String,
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

/**
 * The Flake fixer: an opencode agent editing a copy of the branch. The
 * Updater runs repair rounds only when this service is provided.
 */
export class Agent extends Context.Service<
  Agent,
  {
    /** The directory the agent edits; nothing outside it is kept. */
    readonly workspace: string;
    readonly repair: (
      request: RepairRequest
    ) => Effect.Effect<RepairResult, AgentError>;
  }
>()("flake-updater/agent") {}
