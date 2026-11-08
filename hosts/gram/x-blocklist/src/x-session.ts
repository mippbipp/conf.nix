import type { Effect, Option } from "effect";
import { Context, Schema } from "effect";

import type { Account, AccountsPage } from "./account.ts";
import type { DecodeError } from "./decode-error.ts";

/** X answered a request with a status other than success. */
export class XRequestError extends Schema.TaggedError<
  XRequestError,
  { readonly brand: unique symbol }
>()("XRequestError", {
  message: Schema.String,
  status: Schema.Finite,
}) {}

/** What X said about one block or unblock request. */
export interface ChangeResponse {
  readonly status: number;
  /** The ID of the account X names in the response, when it names one. */
  readonly id: Option.Option<string>;
}

/** The X website's own endpoints, called as the logged-in account. */
export class XSession extends Context.Service<
  XSession,
  {
    /** One page of the accounts the logged-in account blocks. */
    readonly blockedPage: (
      cursor: Option.Option<string>
    ) => Effect.Effect<AccountsPage, XRequestError | DecodeError>;
    readonly block: (
      account: Account
    ) => Effect.Effect<ChangeResponse, XRequestError>;
    readonly unblock: (
      account: Account
    ) => Effect.Effect<ChangeResponse, XRequestError>;
  }
>()("x-blocklist/x-session/XSession") {}
