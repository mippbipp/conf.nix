import { Effect, Layer, Option } from "effect";

import {
  Clankwall,
  ClankwallError,
  decodeFlaggedPage,
  firstPage,
} from "../clankwall.ts";

const origin = "https://clankwall.vogel.dev";

/** What `goto` resolves to in Playwright, as far as this adapter reads it. */
export interface BrowserResponse {
  readonly status: () => number;
  readonly text: () => Promise<string>;
}

/** A tab of its own for Clankwall, from the `context` `browse execute` provides. */
export interface ClankwallTab {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: "load" }
  ) => Promise<BrowserResponse | null>;
  readonly close: () => Promise<void>;
}

export interface BrowserContext {
  readonly newPage: () => Promise<ClankwallTab>;
}

const unreachable = (what: string) => () =>
  ClankwallError.make({ message: `could not ${what} Clankwall` });

// x.com's content security policy blocks fetches to other origins from the X
// tab, so Clankwall is read by opening each API page in a second tab.
export const layer = (context: BrowserContext) =>
  Layer.effect(
    Clankwall,
    Effect.gen(function* () {
      const tab = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => context.newPage(),
          catch: unreachable("open a tab for"),
        }),
        (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore)
      );

      return Clankwall.of({
        flaggedPage: Effect.fn("ClankwallLive.flaggedPage")(function* (cursor) {
          const path = Option.getOrElse(cursor, () => firstPage);

          const response = yield* Effect.tryPromise({
            try: () => tab.goto(`${origin}${path}`, { waitUntil: "load" }),
            catch: unreachable("read"),
          });

          if (response === null || response.status() !== 200) {
            return yield* ClankwallError.make({
              message: `Clankwall answered ${response?.status() ?? "nothing"}`,
            });
          }

          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: unreachable("read"),
          });

          return yield* decodeFlaggedPage(body);
        }),
      });
    })
  );
