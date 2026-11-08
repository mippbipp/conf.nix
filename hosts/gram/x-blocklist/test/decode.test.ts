import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";

import { decodeBlockedPage } from "../src/blocked.ts";
import { decodeFlaggedPage } from "../src/clankwall.ts";
import { toJson } from "./fakes.ts";

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(`${import.meta.dirname}/fixtures/${name}`);
  }).pipe(Effect.provide(NodeServices.layer));

describe("blockedAccountsAll decoding", () => {
  // Captured from X, cut down to two accounts' IDs and handles.
  it.effect("reads the blocked accounts and the next cursor", () =>
    Effect.gen(function* () {
      const body = yield* fixture("blocked-accounts.json");
      const page = yield* decodeBlockedPage(body);

      assert.deepStrictEqual(page.accounts, [
        { id: "2117395986658025472", handle: "getradaria" },
        { id: "2116792142949421056", handle: "packleaderseo" },
      ]);
      assert.isTrue(Option.isSome(page.next));
    })
  );

  it.effect("skips an entry X returns no user for", () =>
    Effect.gen(function* () {
      const body = toJson({
        data: {
          viewer: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        content: {
                          __typename: "TimelineTimelineItem",
                          itemContent: { user_results: {} },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      });

      const page = yield* decodeBlockedPage(body);

      assert.deepStrictEqual(page.accounts, []);
      assert.deepStrictEqual(page.next, Option.none());
    })
  );

  it.effect("fails on a body that isn't a BlockedAccountsAll response", () =>
    Effect.gen(function* () {
      const error = yield* decodeBlockedPage('{"errors":[]}').pipe(Effect.flip);

      assert.strictEqual(
        error.message,
        "unexpected BlockedAccountsAll response"
      );
    })
  );
});

describe("clankwall decoding", () => {
  // Captured from /api/accounts?flag=ai&limit=2.
  it.effect("reads the flagged accounts and the next page", () =>
    Effect.gen(function* () {
      const body = yield* fixture("clankwall-accounts.json");
      const page = yield* decodeFlaggedPage(body);

      assert.deepStrictEqual(page.accounts, [
        { id: "1992461", handle: "fishjar" },
        { id: "18010811", handle: "neiljesani" },
      ]);
      assert.deepStrictEqual(
        page.next,
        Option.some(
          "/api/accounts?flag=ai&limit=2&snapshot=1d668996c156ed275750d474fcf413ca&cursor=18010811"
        )
      );
    })
  );

  it.effect("ends at a page with no next link", () =>
    Effect.gen(function* () {
      const page = yield* decodeFlaggedPage(
        toJson({ next: null, accounts: [] })
      );

      assert.deepStrictEqual(page.next, Option.none());
    })
  );
});
