import {
  Array as Arr,
  Effect,
  Layer,
  Option,
  Record as Rec,
  Schedule,
  Schema,
  String as Str,
} from "effect";

import type { Account } from "../account.ts";
import { decodeBlockedPage } from "../blocked.ts";
import { XRequestError, XSession } from "../x-session.ts";

export interface BrowserRequest {
  readonly url: () => string;
  readonly headers: () => Readonly<Record<string, string>>;
}

/** The parts of Playwright's `page` that `browse execute` provides. */
export interface BrowserPage {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: "domcontentloaded" }
  ) => Promise<null>;
  readonly on: (
    event: "request",
    listener: (request: BrowserRequest) => void
  ) => BrowserPage;
  readonly url: () => string;
  readonly evaluate: <A, R>(fn: (arg: A) => Promise<R>, arg: A) => Promise<R>;
}

interface PageRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

interface PageResponse {
  readonly status: number;
  readonly text: string;
}

// Runs inside the X tab, so the request carries the account's cookies.
// Playwright sends this function to the page as source text, where Effect
// isn't loaded: it may only use its argument and browser globals.
// oxlint-disable-next-line effecttsgo/async-function -- see above
const fetchInPage = async (request: PageRequest): Promise<PageResponse> => {
  // oxlint-disable-next-line effecttsgo/global-fetch -- see above
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: "include",
  });

  return { status: response.status, text: await response.text() };
};

// The headers the X web app authenticates its own API calls with.
const authHeaders = [
  "authorization",
  "x-csrf-token",
  "x-twitter-auth-type",
  "x-twitter-active-user",
  "x-twitter-client-language",
] as const;

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

interface Template {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

const toTemplate = (request: BrowserRequest): Template => {
  const headers = request.headers();

  return {
    url: request.url(),
    headers: Rec.fromEntries(
      Arr.flatMap(authHeaders, (name) =>
        Option.match(Rec.get(headers, name), {
          onNone: () => [],
          onSome: (value) => [[name, value] as const],
        })
      )
    ),
  };
};

/**
 * Opens the blocked accounts settings page and copies the headers of the
 * page's own `BlockedAccountsAll` request, which later calls reuse.
 */
const captureTemplate = Effect.fn("XSessionLive.captureTemplate")(function* (
  page: BrowserPage
) {
  let captured = Option.none<Template>();

  page.on("request", (request) => {
    if (
      Option.isNone(captured) &&
      Str.includes("/BlockedAccountsAll?")(request.url())
    ) {
      captured = Option.some(toTemplate(request));
    }
  });

  yield* Effect.tryPromise({
    try: () =>
      page.goto("https://x.com/settings/blocked/all", {
        waitUntil: "domcontentloaded",
      }),
    catch: () =>
      XRequestError.make({
        message: "could not open the blocked accounts page",
        status: 0,
      }),
  });

  const notSeen = () =>
    XRequestError.make({
      message: `no BlockedAccountsAll request seen, is X logged in? (${page.url()})`,
      status: 0,
    });

  return yield* Effect.suspend(() =>
    Effect.fromOption(captured).pipe(Effect.mapError(notSeen))
  ).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }));
});

export const layer = (page: BrowserPage) =>
  Layer.effect(
    XSession,
    Effect.gen(function* () {
      const template = yield* captureTemplate(page);

      const call = (request: PageRequest, what: string) =>
        Effect.tryPromise({
          try: () => page.evaluate(fetchInPage, request),
          catch: () =>
            XRequestError.make({
              message: `${what} request failed`,
              status: 0,
            }),
        });

      const change = (path: string, what: string) => (account: Account) =>
        Effect.map(
          call(
            {
              url: `https://x.com/i/api/1.1/blocks/${path}.json`,
              method: "POST",
              headers: {
                ...template.headers,
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ user_id: account.id }).toString(),
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

          const url = new URL(template.url);

          url.searchParams.set("variables", variables);

          const response = yield* call(
            {
              url: url.toString(),
              method: "GET",
              headers: template.headers,
              body: undefined,
            },
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
