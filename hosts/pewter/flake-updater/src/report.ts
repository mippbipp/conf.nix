import { Schema } from "effect";

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
