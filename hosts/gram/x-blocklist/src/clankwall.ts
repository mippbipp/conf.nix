import { Array as Arr, Context, Effect, Option, Schema } from "effect";

import type { AccountsPage } from "./account.ts";
import { DecodeError } from "./decode-error.ts";

/** Clankwall couldn't be read, or listed nothing. */
export class ClankwallError extends Schema.TaggedError<
  ClankwallError,
  { readonly brand: unique symbol }
>()("ClankwallError", { message: Schema.String }) {}

/** clankwall.vogel.dev's public list of flagged X accounts. */
export class Clankwall extends Context.Service<
  Clankwall,
  {
    /**
     * One page of the AI-flagged accounts. The cursor is the `next` path
     * the previous page returned.
     */
    readonly flaggedPage: (
      cursor: Option.Option<string>
    ) => Effect.Effect<AccountsPage, ClankwallError | DecodeError>;
  }
>()("x-blocklist/clankwall") {}

/** The first page; later pages come from each page's `next` link. */
export const firstPage = "/api/accounts?flag=ai&limit=500";

const Response = Schema.Struct({
  next: Schema.NullOr(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, username: Schema.String })
  ),
});

const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

/** Decodes the body of Clankwall's `/api/accounts` response. */
export const decodeFlaggedPage = Effect.fn("decodeFlaggedPage")(function* (
  body: string
) {
  const response = yield* decodeResponse(body).pipe(
    Effect.mapError((cause) =>
      DecodeError.make({
        message: "unexpected Clankwall response",
        cause,
      })
    )
  );

  return {
    accounts: Arr.map(response.accounts, (entry) => ({
      id: entry.id,
      handle: entry.username,
    })),
    next: Option.fromNullishOr(response.next),
  } satisfies AccountsPage;
});
