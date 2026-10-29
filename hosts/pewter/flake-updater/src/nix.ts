import type { Effect } from "effect";
import { Context, Schema } from "effect";

export class NixError extends Schema.TaggedError<
  NixError,
  { readonly brand: unique symbol }
>()("NixError", { message: Schema.String, cause: Schema.Defect() }) {}

export class Nix extends Context.Service<
  Nix,
  {
    /** `nix flake update` in the Updater's checkout. */
    readonly update: Effect.Effect<void, NixError>;
  }
>()("flake-updater/nix") {}
