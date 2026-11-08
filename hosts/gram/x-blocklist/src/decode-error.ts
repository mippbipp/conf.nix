import { Schema } from "effect";

/** A response body didn't have the shape the decoder expects. */
export class DecodeError extends Schema.TaggedError<
  DecodeError,
  { readonly brand: unique symbol }
>()("DecodeError", { message: Schema.String, cause: Schema.Defect() }) {}
