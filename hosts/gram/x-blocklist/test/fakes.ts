import { Array as Arr, Effect, Layer, Option, String as Str } from "effect";
import type { Schema } from "effect";

import type { Account, AccountsPage } from "../src/account.ts";
import { Clankwall, ClankwallError } from "../src/clankwall.ts";
import { Settings } from "../src/settings.ts";
import type { BlocklistSettings } from "../src/settings.ts";
import { XRequestError, XSession } from "../src/x-session.ts";

/** Fake API bodies: plain JSON values, so stringify cannot throw. */
export const toJson = (value: Schema.Json): string =>
  // oxlint-disable-next-line effecttsgo/global-json -- see above
  JSON.stringify(value);

export const account = (handle: string): Account => ({
  id: `id-${handle}`,
  handle,
});

const pageSize = 100;

// Cursors are `cursor-<offset>`, as paged builds them.
const paged = (
  accounts: readonly Account[],
  cursor: Option.Option<string>
): AccountsPage => {
  const start = Option.match(cursor, {
    onNone: () => 0,
    onSome: (value) => Number(Str.slice("cursor-".length)(value)),
  });

  const end = start + pageSize;

  return {
    accounts: accounts.slice(start, end),
    next: end < accounts.length ? Option.some(`cursor-${end}`) : Option.none(),
  };
};

export interface FakeRequest {
  readonly kind: "block" | "unblock";
  readonly handle: string;
}

/** The fake X: the account's blocked list, and every change it was asked for. */
export class FakeX {
  public readonly blocked: Account[];
  /** Status X answers a block or unblock with, per handle; 200 when absent. */
  public readonly status = new Map<string, number>();
  /** Account X names in a successful response, per requested handle. */
  public readonly answeredAs = new Map<string, Account>();
  public readonly requests: FakeRequest[] = [];
  public blockedStatus = 200;
  public pageReads = 0;

  public constructor(blocked: readonly Account[]) {
    this.blocked = [...blocked];
  }

  public blockedHandles(): readonly string[] {
    return Arr.sort(
      Arr.map(this.blocked, (entry) => entry.handle),
      Str.Order
    );
  }
}

/** The fake Clankwall: the AI-flagged accounts it lists. */
export class FakeClankwall {
  public readonly flagged: readonly Account[];
  public status = 200;
  public pageReads = 0;

  public constructor(flagged: readonly Account[]) {
    this.flagged = flagged;
  }
}

const change = (x: FakeX, kind: FakeRequest["kind"], target: Account) =>
  Effect.sync(() => {
    x.requests.push({ kind, handle: target.handle });

    const status = x.status.get(target.handle) ?? 200;

    if (status === 200) {
      const index = Arr.findFirstIndex(
        x.blocked,
        (entry) => entry.id === target.id
      );

      if (kind === "block" && Option.isNone(index)) {
        x.blocked.push(target);
      }

      if (kind === "unblock" && Option.isSome(index)) {
        x.blocked.splice(index.value, 1);
      }
    }

    return {
      status,
      id:
        status === 200
          ? Option.some((x.answeredAs.get(target.handle) ?? target).id)
          : Option.none(),
    };
  });

export const layers = (x: FakeX, clankwall: FakeClankwall) =>
  [
    Layer.succeed(
      XSession,
      XSession.of({
        blockedPage: (cursor) =>
          Effect.suspend(() => {
            x.pageReads += 1;

            return x.blockedStatus === 200
              ? Effect.succeed(paged(x.blocked, cursor))
              : Effect.fail(
                  XRequestError.make({
                    message: "BlockedAccountsAll failed",
                    status: x.blockedStatus,
                  })
                );
          }),
        block: (target) => change(x, "block", target),
        unblock: (target) => change(x, "unblock", target),
      })
    ),
    Layer.succeed(
      Clankwall,
      Clankwall.of({
        flaggedPage: (cursor) =>
          Effect.suspend(() => {
            clankwall.pageReads += 1;

            return clankwall.status === 200
              ? Effect.succeed(paged(clankwall.flagged, cursor))
              : Effect.fail(
                  ClankwallError.make({
                    message: `Clankwall answered ${clankwall.status}`,
                  })
                );
          }),
      })
    ),
  ] as const;

export const defaults: BlocklistSettings = {
  dryRun: false,
  pause: { min: 4000, max: 7000 },
};

export const settingsLayer = (overrides: Partial<BlocklistSettings> = {}) =>
  Layer.succeed(Settings, Settings.of({ ...defaults, ...overrides }));
