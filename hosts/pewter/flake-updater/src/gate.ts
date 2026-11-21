import type { Effect } from "effect";
import { Context, Schema } from "effect";

import type { PullRequest } from "./github.ts";

export class GateError extends Schema.TaggedError<
  GateError,
  { readonly brand: unique symbol }
>()("GateError", { cause: Schema.Defect(), message: Schema.String }) {}

export interface FailedCheck {
  /** Raw failed-step log in `gh run view --log-failed` format. */
  readonly log: string;
  readonly name: string;
  readonly url: string;
}

/** The gate passed when no check failed. */
export interface GateVerdict {
  readonly failed: ReadonlyArray<FailedCheck>;
}

/** Waits for the Build gate's verdict on a pushed commit. */
export class Gate extends Context.Service<
  Gate,
  {
    readonly verdict: (
      pr: PullRequest,
      sha: string
    ) => Effect.Effect<GateVerdict, GateError>;
  }
>()("flake-updater/gate") {}
