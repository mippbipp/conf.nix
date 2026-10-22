import { Schema } from "effect";

/**
 * Errors raised by the dGPU domain. The UI shows `message` directly, while
 * `cause` keeps the original platform or schema failure for logs.
 */
export class DgpuError extends Schema.TaggedError<DgpuError>()("DgpuError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
