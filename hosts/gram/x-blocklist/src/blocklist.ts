import {
  Array as Arr,
  Duration,
  Effect,
  HashSet,
  Option,
  Random,
} from "effect";

import type { Account, AccountsPage } from "./account.ts";
import { Clankwall, ClankwallError } from "./clankwall.ts";
import { Settings } from "./settings.ts";
import { XSession } from "./x-session.ts";
import type { ChangeResponse } from "./x-session.ts";

/** One block or unblock request and what X said about it. */
export interface Action {
  readonly kind: "block" | "unblock";
  readonly id: string;
  readonly handle: string;
  readonly status: number;
  /** X answered 200 and named this account's ID in the response. */
  readonly confirmed: boolean;
}

/** What one run did. */
export interface Report {
  /** How many accounts Clankwall flags as AI. */
  readonly flagged: number;
  /** How many accounts the X account blocked when the run started. */
  readonly blockedBefore: number;
  readonly actions: readonly Action[];
  /** Changes still needed after this run, for a dry or stopped run. */
  readonly pending: { readonly block: number; readonly unblock: number };
  /** The status that ended the run early, when X refused to go on. */
  readonly stoppedAt: Option.Option<number>;
}

// 401 and 403 mean the session or account has a problem, 429 is a rate
// limit: another request would only make it worse.
const stopStatuses: ReadonlySet<number> = new Set([401, 403, 429]);

/** Every account a paged list holds, following the cursor to the end. */
const readAll = Effect.fnUntraced(function* <E, R>(
  page: (cursor: Option.Option<string>) => Effect.Effect<AccountsPage, E, R>
) {
  const accounts: Account[] = [];
  let cursor = Option.none<string>();

  do {
    const current = yield* page(cursor);

    accounts.push(...current.accounts);
    // An empty page ends the list even if it still sends a cursor.
    cursor = Arr.isReadonlyArrayNonEmpty(current.accounts)
      ? current.next
      : Option.none();
  } while (Option.isSome(cursor));

  return accounts;
});

const idsOf = (accounts: readonly Account[]) =>
  HashSet.fromIterable(Arr.map(accounts, (entry) => entry.id));

/**
 * Makes the X account's blocked list match Clankwall's AI-flagged accounts:
 * blocks flagged accounts it doesn't block yet and unblocks everyone else.
 */
export const run = Effect.fn("Blocklist.run")(function* () {
  const x = yield* XSession;
  const clankwall = yield* Clankwall;
  const settings = yield* Settings;
  const flagged = yield* readAll(clankwall.flaggedPage);

  // An empty list is far likelier an outage than Clankwall clearing every
  // flag, and syncing to it would unblock everyone.
  if (!Arr.isReadonlyArrayNonEmpty(flagged)) {
    return yield* ClankwallError.make({
      message: "Clankwall lists no accounts",
    });
  }

  const blocked = yield* readAll(x.blockedPage);
  const flaggedIds = idsOf(flagged);
  const blockedIds = idsOf(blocked);

  const toBlock = Arr.filter(
    Arr.dedupeWith(flagged, (a, b) => a.id === b.id),
    (entry) => !HashSet.has(blockedIds, entry.id)
  );

  const toUnblock = Arr.filter(
    blocked,
    (entry) => !HashSet.has(flaggedIds, entry.id)
  );

  const planned = [
    ...Arr.map(toBlock, (target) => ({ kind: "block" as const, target })),
    ...Arr.map(toUnblock, (target) => ({ kind: "unblock" as const, target })),
  ];

  const pause = Effect.flatMap(
    Random.nextIntBetween(settings.pause.min, settings.pause.max),
    (millis) => Effect.sleep(Duration.millis(millis))
  );

  const send = (kind: Action["kind"], target: Account) =>
    kind === "block" ? x.block(target) : x.unblock(target);

  const actions: Action[] = [];
  let stoppedAt = Option.none<number>();

  for (const { kind, target } of settings.dryRun ? [] : planned) {
    if (Arr.isReadonlyArrayNonEmpty(actions)) {
      yield* pause;
    }

    const response: ChangeResponse = yield* send(kind, target);

    actions.push({
      kind,
      id: target.id,
      handle: target.handle,
      status: response.status,
      confirmed:
        response.status === 200 && Option.contains(response.id, target.id),
    });

    if (stopStatuses.has(response.status)) {
      stoppedAt = Option.some(response.status);
      break;
    }
  }

  const done = (kind: Action["kind"]) =>
    Arr.filter(actions, (action) => action.kind === kind && action.confirmed)
      .length;

  return {
    flagged: flagged.length,
    blockedBefore: blocked.length,
    actions,
    pending: {
      block: toBlock.length - done("block"),
      unblock: toUnblock.length - done("unblock"),
    },
    stoppedAt,
  } satisfies Report;
});
