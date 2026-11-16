import { Array as Arr, Effect, Layer, Option, Schedule, Schema } from "effect";

import type { Account } from "../account.ts";
import { decodeBlockedPage } from "../blocked.ts";
import { Browse } from "../browse.ts";
import { XRequestError, XSession } from "../x-session.ts";
import { fetchInPage, findBearer } from "./in-page.ts";
import type { PageRequest } from "./in-page.ts";

/** The browse tab group the run's tab opens in. */
const group = "x-blocklist";

const blockedSettings = "https://x.com/settings/blocked/all";

const Opened = Schema.Struct({ tab: Schema.Finite });

const Capture = Schema.Struct({ entryCount: Schema.Finite });

const Exchange = Schema.Struct({
  request: Schema.Struct({ url: Schema.String }),
});

const Captured = Schema.Struct({ exchanges: Schema.Array(Exchange) });

const decodeJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S
) => Schema.decodeEffect(Schema.fromJsonString(schema));

const decodeResponse = decodeJson(
  Schema.Struct({ status: Schema.Finite, text: Schema.String })
);

const decodeBearer = decodeJson(Schema.NullOr(Schema.String));

// blocks/create and blocks/destroy both answer with the user they changed.
const decodeChangeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id_str: Schema.String }))
);

const BlockedVariables = Schema.Struct({
  count: Schema.Finite,
  includePromotedContent: Schema.Boolean,
  cursor: Schema.optionalKey(Schema.String),
});

const encodeVariables = Schema.encodeEffect(
  Schema.fromJsonString(BlockedVariables)
);

const failed = (message: string) => () =>
  XRequestError.make({ message, status: 0 });

/**
 * Opens a tab on the blocked accounts settings page, and reads the URL of
 * the page's own `BlockedAccountsAll` request, which later calls reuse.
 */
const openSession = Effect.fn("XSessionLive.openSession")(function* () {
  const browse = yield* Browse;

  const open = browse
    .call("tabs", { action: "new", group })
    .pipe(Effect.flatMap(decodeJson(Opened)));

  // Closing the group also closes any popup X opened from the tab.
  const close = browse
    .call("tabs", { action: "close", group })
    .pipe(Effect.ignore);

  const { tab } = yield* Effect.acquireRelease(open, () => close).pipe(
    Effect.mapError(failed("could not open a tab for X"))
  );

  const network = (args: Readonly<Record<string, Schema.Json>>) =>
    browse.call("network", { tab, ...args });

  yield* network({
    action: "start",
    urlFilter: "/BlockedAccountsAll?",
    bodies: false,
  }).pipe(Effect.mapError(failed("could not watch the X tab's requests")));

  yield* browse
    .call("navigate", { tab, url: blockedSettings, waitUntil: "load" })
    .pipe(Effect.mapError(failed("could not open the blocked accounts page")));

  // X sends BlockedAccountsAll after the page loads.
  yield* network({ action: "status" }).pipe(
    Effect.flatMap(decodeJson(Capture)),
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (capture) => capture.entryCount > 0,
      times: 30,
    }),
    Effect.ignore
  );

  const notSeen = failed("no BlockedAccountsAll request seen, is X logged in?");

  const template = yield* network({ action: "stop" }).pipe(
    Effect.flatMap(decodeJson(Captured)),
    Effect.mapError(notSeen),
    Effect.flatMap((captured) =>
      Effect.fromOption(Arr.head(captured.exchanges)).pipe(
        Effect.mapError(notSeen)
      )
    )
  );

  const bearer = yield* browse
    .call("eval", { tab, expression: String(findBearer) })
    .pipe(
      Effect.flatMap(decodeBearer),
      Effect.mapError(failed("could not read X's bearer token")),
      Effect.flatMap((found) =>
        Effect.fromOption(Option.fromNullishOr(found)).pipe(
          Effect.mapError(failed("X's bundle has no bearer token"))
        )
      )
    );

  const call = (request: Omit<PageRequest, "bearer">, what: string) =>
    browse
      .call("eval", {
        tab,
        expression: String(fetchInPage),
        arg: { ...request, bearer },
      })
      .pipe(
        Effect.flatMap(decodeResponse),
        Effect.mapError(failed(`${what} request failed`))
      );

  return { template: template.request.url, call };
});

export const layer = Layer.effect(
  XSession,
  Effect.gen(function* () {
    const { template, call } = yield* openSession();

    const change = (path: string, what: string) => (account: Account) =>
      Effect.map(
        call(
          {
            url: `https://x.com/i/api/1.1/blocks/${path}.json`,
            method: "POST",
            body: `user_id=${encodeURIComponent(account.id)}`,
            prune: false,
          },
          what
        ),
        (response) => ({
          status: response.status,
          id: Option.map(
            decodeChangeBody(response.text),
            (body) => body.id_str
          ),
        })
      );

    return XSession.of({
      blockedPage: Effect.fn("XSessionLive.blockedPage")(function* (cursor) {
        const variables = yield* encodeVariables({
          count: 100,
          includePromotedContent: false,
          ...Option.match(cursor, {
            onNone: () => ({}),
            onSome: (value) => ({ cursor: value }),
          }),
        }).pipe(Effect.orDie);

        const url = new URL(template);

        url.searchParams.set("variables", variables);

        const response = yield* call(
          { url: url.toString(), method: "GET", body: null, prune: true },
          "BlockedAccountsAll"
        );

        if (response.status !== 200) {
          return yield* XRequestError.make({
            message: "BlockedAccountsAll failed",
            status: response.status,
          });
        }

        return yield* decodeBlockedPage(response.text);
      }),
      block: change("create", "block"),
      unblock: change("destroy", "unblock"),
    });
  })
);
