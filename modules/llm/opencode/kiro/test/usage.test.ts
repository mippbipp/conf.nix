// The usage tracker through its exports, on a fake host: storage in memory
// and an RPC that records its handler and the events it emits. The account
// is a fake KiroAccount that counts its usage reads, and the clock is
// TestClock's, so the account's cache times out only when a test says.

import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Deferred,
  Effect,
  Fiber,
  type Schema,
  type Scope,
} from "effect";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import { KiroApiError } from "../src/failure.ts";
import type { AccountUsage, UsageAnswer } from "../src/rpc.ts";
import { type Host as UsageHost, make as makeUsage } from "../src/usage.ts";
import { assertCloseTo } from "./assert.ts";

// the account as the sidebar is told it, its numbers made up
const ACCOUNT: AccountUsage = {
  allowances: [{ limit: 1000, name: "Credits", used: 12 }],
  checkedAt: 1_793_000_000_000,
  plan: "Kiro Pro",
  resetsAt: 1_793_491_200_000,
};

// a KiroAccount whose usage reads are counted; read is what the next one gives
function fakeAccount() {
  const unused = Effect.die("the tracker doesn't call this");
  // a test can swap in a failing read
  const read: Effect.Effect<AccountUsage, KiroApiError> =
    Effect.succeed(ACCOUNT);
  const fake = { read, reads: 0 };
  const service = KiroAccount.of({
    credentials: () => unused,
    models: unused,
    usage: Effect.suspend(() => {
      fake.reads += 1;
      return fake.read;
    }),
  });
  return Object.assign(fake, { service });
}

// the RPC's usage handler, as the tracker registers it
type Handler = (
  input: { sessionIDs: Array<string> },
  context: unknown
) => Effect.Effect<UsageAnswer>;

// the host: storage in memory, the RPC's usage handler, and the events it
// emitted. With registers false, registering the RPC fails. holdNextRead
// makes the next storage read answer only once its gate is done, with the
// value storage held when it was asked, as a slow storage would.
function fakeHost(registers = true) {
  const store = new Map<string, Schema.Json>();
  const emitted: Array<string> = [];
  const handlers: Array<Handler> = [];
  const gates: Array<Deferred.Deferred<boolean>> = [];
  const host: UsageHost = {
    rpc: {
      register: (_definition, registered) =>
        registers
          ? Effect.sync(() => {
              // SAFETY: the tracker registers only KiroRpc, whose one method is usage
              handlers.push((registered as { readonly usage: Handler }).usage);
              return {
                dispose: Effect.void,
                events: {
                  emit: (...[name]) =>
                    Effect.sync(() => void emitted.push(name)),
                },
              };
            })
          : Effect.fail("the RPC is unavailable"),
    },
    storage: {
      get: (key) =>
        Effect.suspend(() => {
          const value = store.get(key);
          const gate = gates.shift();
          return gate === undefined
            ? Effect.succeed(value)
            : Deferred.await(gate).pipe(Effect.as(value));
        }),
      set: (key, value) => Effect.sync(() => void store.set(key, value)),
    },
  };
  return {
    ask: (...sessionIDs: Array<string>) =>
      Effect.fromOption(Arr.last(handlers)).pipe(
        Effect.orDie,
        Effect.flatMap((handler) => handler({ sessionIDs }, {}))
      ),
    emitted,
    holdNextRead: (gate: Deferred.Deferred<boolean>) => {
      gates.push(gate);
    },
    host,
    store,
  };
}

// effect run in a scope that stays open while it runs, as the plugin's does
const run = <A, E>(
  account: ReturnType<typeof fakeAccount>,
  effect: Effect.Effect<A, E, KiroAccount | Scope.Scope>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provideService(KiroAccount, account.service)
  );

// what record starts runs beside the test, so each step gives it a moment
const settle = TestClock.withLive(Effect.sleep("10 millis"));

describe("the usage tracker", () => {
  it.effect(
    "usage: a session's replies add up in storage, and the RPC answers what each session spent",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost();
        const answer = yield* run(
          account,
          Effect.gen(function* () {
            const tracker = yield* makeUsage(fake.host);
            yield* tracker.record("ses_a", { credits: 0.091 });
            yield* settle;
            yield* tracker.record("ses_a", { credits: 0.25 });
            yield* settle;
            return yield* fake.ask("ses_a", "ses_b");
          })
        );
        assert.deepStrictEqual(answer.account, ACCOUNT);
        assert.isUndefined(answer.error);
        assertCloseTo(answer.credits.ses_a, 0.341);
        assert.strictEqual(answer.credits.ses_b, 0);
        assertCloseTo(fake.store.get("credits/ses_a"), 0.341);
        assert.isFalse(fake.store.has("credits/ses_b"));
        // each reply tells the sidebar to look again
        assert.deepStrictEqual(fake.emitted, ["updated", "updated"]);
      })
  );

  it.effect(
    "usage: a session's credits from an earlier run are read from storage",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost();
        fake.store.set("credits/ses_old", 12.4);
        const answer = yield* run(
          account,
          Effect.gen(function* () {
            const tracker = yield* makeUsage(fake.host);
            yield* tracker.record("ses_old", { credits: 1 });
            yield* settle;
            return yield* fake.ask("ses_old");
          })
        );
        assertCloseTo(answer.credits.ses_old, 13.4);
        assertCloseTo(fake.store.get("credits/ses_old"), 13.4);
      })
  );

  it.effect(
    "usage: an account Kiro won't show is an error in the answer, not a failure",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        account.read = KiroApiError.fromReply(
          403,
          '{"message":"Not allowed","reason":null}'
        );
        const fake = fakeHost();
        const answer = yield* run(
          account,
          Effect.gen(function* () {
            yield* makeUsage(fake.host);
            return yield* fake.ask("ses_x");
          })
        );
        assert.deepStrictEqual(answer, {
          account: null,
          credits: { ses_x: 0 },
          error: "Kiro: Not allowed (HTTP 403)",
        });
      })
  );

  it.effect(
    "usage: the account is read again 60 seconds after a read that worked, not sooner",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost();
        const reads = yield* run(
          account,
          Effect.gen(function* () {
            yield* makeUsage(fake.host);
            const seen: Array<number> = [];
            yield* fake.ask();
            seen.push(account.reads);
            yield* TestClock.adjust("59 seconds");
            yield* fake.ask();
            seen.push(account.reads);
            yield* TestClock.adjust("1 second");
            yield* fake.ask();
            seen.push(account.reads);
            return seen;
          })
        );
        assert.deepStrictEqual(reads, [1, 1, 2]);
      })
  );

  it.effect(
    "usage: the account is read again 10 seconds after a read that failed",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        account.read = KiroApiError.fromReply(500, "");
        const fake = fakeHost();
        const reads = yield* run(
          account,
          Effect.gen(function* () {
            yield* makeUsage(fake.host);
            const seen: Array<number> = [];
            yield* fake.ask();
            seen.push(account.reads);
            yield* TestClock.adjust("9 seconds");
            yield* fake.ask();
            seen.push(account.reads);
            yield* TestClock.adjust("1 second");
            yield* fake.ask();
            seen.push(account.reads);
            return seen;
          })
        );
        assert.deepStrictEqual(reads, [1, 1, 2]);
      })
  );

  it.effect(
    "usage: a reply ending while the account is being read counts, and starts no second read",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost();
        const out = yield* run(
          account,
          Effect.gen(function* () {
            // the read Kiro hasn't answered yet
            const gate = yield* Deferred.make<AccountUsage>();
            account.read = Deferred.await(gate);
            const tracker = yield* makeUsage(fake.host);
            yield* tracker.record("ses_a", { credits: 1 });
            yield* settle;
            yield* tracker.record("ses_a", { credits: 2 });
            yield* settle;
            const during = { emitted: [...fake.emitted], reads: account.reads };
            yield* Deferred.succeed(gate, ACCOUNT);
            yield* settle;
            return { answer: yield* fake.ask("ses_a"), during };
          })
        );
        assert.deepStrictEqual(out.during, { emitted: [], reads: 1 });
        assert.deepStrictEqual(fake.emitted, ["updated"]);
        assert.strictEqual(account.reads, 1);
        assert.strictEqual(out.answer.credits.ses_a, 3);
      })
  );

  it.effect(
    "usage: an RPC whose storage read answers late keeps a reply's credits counted meanwhile",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost();
        fake.store.set("credits/ses_a", 5);
        const answer = yield* run(
          account,
          Effect.gen(function* () {
            const tracker = yield* makeUsage(fake.host);
            const gate = yield* Deferred.make<boolean>();
            fake.holdNextRead(gate);
            // the sidebar asks first, and storage answers it after the reply
            const asking = yield* Effect.forkChild(fake.ask("ses_a"));
            yield* settle;
            yield* tracker.record("ses_a", { credits: 1 });
            yield* settle;
            yield* Deferred.succeed(gate, true);
            const late = yield* Fiber.join(asking);
            yield* tracker.record("ses_a", { credits: 2 });
            yield* settle;
            return late;
          })
        );
        assert.strictEqual(answer.credits.ses_a, 6);
        assert.strictEqual(fake.store.get("credits/ses_a"), 8);
      })
  );

  it.effect(
    "usage: when the RPC can't be registered, replies still count and nothing is emitted",
    () =>
      Effect.gen(function* () {
        const account = fakeAccount();
        const fake = fakeHost(false);
        yield* run(
          account,
          Effect.gen(function* () {
            const tracker = yield* makeUsage(fake.host);
            yield* tracker.record("ses_a", { credits: 0.5 });
            yield* settle;
          })
        );
        assert.strictEqual(fake.store.get("credits/ses_a"), 0.5);
        assert.deepStrictEqual(fake.emitted, []);
      })
  );
});
