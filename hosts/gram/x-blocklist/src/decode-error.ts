import { Schema } from "effect";

/** A response body didn't have the shape the decoder expects. */
export class DecodeError extends Schema.TaggedError<
  DecodeError,
  { readonly brand: unique symbol }
>()("DecodeError", { cause: Schema.Defect(), message: Schema.String }) {}
