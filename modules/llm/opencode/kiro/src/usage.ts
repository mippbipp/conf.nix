// What the account and each session have used, for the sidebar.
//
// The sidebar asks over the RPC in rpc.ts for the account's usage this
// month and the credits each of its sessions has spent. The account's usage
// is Kiro's (KiroAccount.usage), read at most once a minute. A session's
// credits are counted here from its replies' meteringEvents and kept in the
// plugin's storage, so they outlast a restart.

import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Option, Schema, Semaphore, String as Str } from "effect";

import { KiroAccount } from "./account.ts";
import type * as Conversation from "./conversation.ts";
import * as Failure from "./failure.ts";
import { KiroRpc, type UsageAnswer } from "./rpc.ts";

// Host is the part of OpenCode's plugin context the tracker uses.
export type Host = {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set">;
  readonly rpc: Pick<Plugin.Context["rpc"], "register">;
};

// the account part of the usage RPC's answer
type AccountNow = Omit<UsageAnswer, "credits">;

// what each session has spent, kept in the plugin's storage
const creditsKey = (sessionID: string) => `credits/${sessionID}`;
const decodeCredits = Schema.decodeUnknownOption(Schema.Finite);

// Tracker counts what each reply cost. record adds a reply's credits to
// its session's, then reads the account again and tells the sidebar to ask
// once more. It runs in the background, in the scope make ran in, and
// logs what fails, so a reply never waits on it or fails by it.
export interface Tracker {
  readonly record: (
    sessionID: string | undefined,
    usage: Pick<Conversation.Usage, "credits">
  ) => Effect.Effect<void>;
}

// make registers the usage RPC with the host and returns the tracker. If
// registering fails, the sidebar shows nothing and the tracker still counts.
export const make = Effect.fn("Usage.make")(function* (host: Host) {
  const account = yield* KiroAccount;
  // where record's work runs: the scope make runs in, the plugin's own. A
  // reply's stream would end the work with its body.
  const scope = yield* Effect.scope;

  // the account's usage, read at most once a minute (a failure, every 10
  // seconds), and a short reason when it can't be
  const [usageCached, usageStale] = yield* Effect.cachedInvalidateWithTTL(account.usage, (exit) =>
    Exit.isSuccess(exit) ? "60 seconds" : "10 seconds"
  );
  const accountNow = usageCached.pipe(
    Effect.map((usage): AccountNow => ({ account: usage })),
    Effect.catchCause((cause) =>
      Effect.succeed({
        account: null,
        error: Str.slice(0, 200)(Failure.fromCause(cause).message),
      })
    )
  );

  // the credits each session has spent: storage's, and what was added since
  const credits = new Map<string, number>();
  const creditLock = yield* Semaphore.make(1);
  const creditsOf = Effect.fnUntraced(function* (sessionID: string) {
    const known = credits.get(sessionID);
    if (known !== undefined) return known;
    const saved = Option.getOrElse(
      decodeCredits(yield* host.storage.get(creditsKey(sessionID))),
      () => 0
    );
    // a reply may have added to the session's credits during the read
    const total = credits.get(sessionID) ?? saved;
    credits.set(sessionID, total);
    return total;
  });
  const addCredits = Effect.fnUntraced(function* (sessionID: string, spent: number) {
    const total = (yield* creditsOf(sessionID)) + spent;
    credits.set(sessionID, total);
    yield* host.storage.set(creditsKey(sessionID), total);
  }, creditLock.withPermits(1));

  // without the RPC the sidebar shows nothing, and Kiro still answers
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC API fails with unknown
  const registration = yield* host.rpc
    .register(KiroRpc, {
      usage: Effect.fnUntraced(function* ({ sessionIDs }) {
        const spent: Record<string, number> = {};
        for (const id of sessionIDs) spent[id] = yield* creditsOf(id);
        const answer: UsageAnswer = { ...(yield* accountNow), credits: spent };
        return answer;
      }),
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kiro: registering the usage RPC failed", cause).pipe(
          Effect.as(undefined)
        )
      )
    );
  // telling the sidebar is best effort
  const emitUpdated = registration
    ? // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC fails with unknown
      registration.events.emit("updated", {}).pipe(Effect.ignore)
    : Effect.void;

  // after a reply, the account read again and the sidebar told. One read
  // runs at a time; a reply ending during one is in what it tells.
  const refreshing = yield* Semaphore.make(1);
  const refreshUsage = usageStale.pipe(
    Effect.andThen(accountNow),
    Effect.andThen(emitUpdated),
    Effect.ignore,
    refreshing.withPermitsIfAvailable(1)
  );

  const record: Tracker["record"] = Effect.fnUntraced(
    function* (sessionID, usage) {
      if (sessionID && usage.credits > 0) yield* addCredits(sessionID, usage.credits);
      yield* refreshUsage;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro: counting a reply's credits failed", cause)
    ),
    Effect.forkIn(scope),
    Effect.asVoid
  );

  return { record } satisfies Tracker;
});
