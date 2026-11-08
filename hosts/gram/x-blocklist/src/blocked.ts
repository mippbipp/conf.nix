import { Array as Arr, Effect, Option, Schema } from "effect";

import type { Account, AccountsPage } from "./account.ts";
import { DecodeError } from "./decode-error.ts";

const User = Schema.Struct({
  __typename: Schema.Literal("User"),
  rest_id: Schema.String,
  core: Schema.Struct({ screen_name: Schema.String }),
});

// Suspended or deleted accounts can come back without a User result; they
// are skipped rather than failing the page.
const UserResults = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
});

const Item = Schema.Struct({
  __typename: Schema.Literal("TimelineTimelineItem"),
  itemContent: Schema.Struct({ user_results: UserResults }),
});

const Cursor = Schema.Struct({
  __typename: Schema.Literal("TimelineTimelineCursor"),
  cursorType: Schema.String,
  value: Schema.String,
});

const Entry = Schema.Struct({
  content: Schema.Union([Item, Cursor, Schema.Struct({})]),
});

const Instruction = Schema.Struct({
  entries: Schema.optionalKey(Schema.Array(Entry)),
});

const Timeline = Schema.Struct({ instructions: Schema.Array(Instruction) });

const Viewer = Schema.Struct({
  timeline: Schema.Struct({ timeline: Timeline }),
});

const Response = Schema.Struct({
  data: Schema.Struct({ viewer: Viewer }),
});

const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

const decodeUser = Schema.decodeUnknownOption(User);

const isItem = Schema.is(Item);

const isCursor = Schema.is(Cursor);

const toAccount = (user: typeof User.Type): Account => ({
  id: user.rest_id,
  handle: user.core.screen_name,
});

const accountOf = (content: typeof Entry.Type.content) =>
  isItem(content)
    ? Option.map(decodeUser(content.itemContent.user_results.result), toAccount)
    : Option.none();

/** Decodes the body of X's `BlockedAccountsAll` GraphQL response. */
export const decodeBlockedPage = Effect.fn("decodeBlockedPage")(function* (
  body: string
) {
  const response = yield* decodeResponse(body).pipe(
    Effect.mapError((cause) =>
      DecodeError.make({
        message: "unexpected BlockedAccountsAll response",
        cause,
      })
    )
  );

  const contents = Arr.flatMap(
    response.data.viewer.timeline.timeline.instructions,
    (instruction) =>
      Arr.map(instruction.entries ?? [], (entry) => entry.content)
  );

  const accounts = Arr.getSomes(Arr.map(contents, accountOf));

  const next = Arr.findFirst(
    Arr.filter(contents, isCursor),
    (cursor) => cursor.cursorType === "Bottom"
  ).pipe(Option.map((cursor) => cursor.value));

  return { accounts, next } satisfies AccountsPage;
});
