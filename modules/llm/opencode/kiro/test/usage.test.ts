// The usage tracker through its exports, on a fake host: storage in memory
// and an RPC that records its handler and the events it emits. The account
// is a fake KiroAccount that counts its usage reads, and the clock is
// TestClock's, so the account's cache times out only when a test says.

import { expect, test } from "bun:test";

import { Deferred, Effect, Fiber, type Scope } from "effect";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import * as Failure from "../src/failure.ts";
import type { AccountUsage, UsageAnswer } from "../src/rpc.ts";
import * as Usage from "../src/usage.ts";

// the account as the sidebar is told it, its numbers made up
const ACCOUNT: AccountUsage = {
  plan: "Kiro Pro",
  resetsAt: 1_793_491_200_000,
  allowances: [{ name: "Credits", used: 12, limit: 1000 }],
  checkedAt: 1_793_000_000_000,
};

// a KiroAccount whose usage reads are counted; read is what the next one gives
function fakeAccount() {
  const unused = Effect.die("the tracker doesn't call this");
  const fake = {
    reads: 0,
    // SAFETY: widens the error type, so a test can swap in a failing read
    read: Effect.succeed(ACCOUNT) as Effect.Effect<AccountUsage, Failure.KiroApiError>,
  };
  const service = KiroAccount.of({
    credentials: () => unused,
    models: unused,
    usage: Effect.suspend(() => {
      fake.reads++;
      return fake.read;
    }),
  });
  return Object.assign(fake, { service });
}

// the host: storage in memory, the RPC's usage handler, and the events it
// emitted. With registers false, registering the RPC fails. holdNextRead
// makes the next storage read answer only once its gate is done, with the
// value storage held when it was asked, as a slow storage would.
function fakeHost(registers = true) {
  const store = new Map<string, unknown>();
  const emitted: string[] = [];
  let usage:
    | ((input: { sessionIDs: string[] }, context: unknown) => Effect.Effect<UsageAnswer>)
    | undefined;
  let held: Deferred.Deferred<boolean> | undefined;
  const host = {
    storage: {
      get: (key: string) =>
        Effect.suspend(() => {
          const value = store.get(key);
          const gate = held;
          held = undefined;
          return gate ? Deferred.await(gate).pipe(Effect.as(value)) : Effect.succeed(value);
        }),
      set: (key: string, value: unknown) => Effect.sync(() => void store.set(key, value)),
    },
    rpc: {
      register: (_definition: unknown, handlers: { usage: typeof usage }) =>
        registers
          ? Effect.sync(() => {
              usage = handlers.usage;
              return {
                dispose: Effect.void,
                events: { emit: (name: string) => Effect.sync(() => void emitted.push(name)) },
              };
            })
          : Effect.fail("the RPC is unavailable"),
    },
  };
  return {
    // SAFETY: the fake has only what the tracker calls
    host: host as unknown as Usage.Host,
    store,
    emitted,
    holdNextRead: (gate: Deferred.Deferred<boolean>) => {
      held = gate;
    },
    ask: (...sessionIDs: string[]) => usage!({ sessionIDs }, {}),
  };
}

// a test on TestClock, in a scope that stays open while it runs, as the
// plugin's does
const run = <A, E>(
  account: ReturnType<typeof fakeAccount>,
  effect: Effect.Effect<A, E, KiroAccount | Scope.Scope>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(TestClock.layer()),
      Effect.scoped,
      Effect.provideService(KiroAccount, account.service)
    )
  );

// what record starts runs beside the test, so each step gives it a moment
const settle = TestClock.withLive(Effect.sleep("10 millis"));

test("usage: a session's replies add up in storage, and the RPC answers what each session spent", async () => {
  const account = fakeAccount();
  const fake = fakeHost();
  const answer = await run(
    account,
    Effect.gen(function* () {
      const tracker = yield* Usage.make(fake.host);
      yield* tracker.record("ses_a", { credits: 0.091 });
      yield* settle;
      yield* tracker.record("ses_a", { credits: 0.25 });
      yield* settle;
      return yield* fake.ask("ses_a", "ses_b");
    })
  );
  expect(answer.account).toEqual(ACCOUNT);
  expect(answer.error).toBeUndefined();
  expect(answer.credits.ses_a).toBeCloseTo(0.341);
  expect(answer.credits.ses_b).toBe(0);
  expect(fake.store.get("credits/ses_a")).toBeCloseTo(0.341);
  expect(fake.store.has("credits/ses_b")).toBe(false);
  // each reply tells the sidebar to look again
  expect(fake.emitted).toEqual(["updated", "updated"]);
});

test("usage: a session's credits from an earlier run are read from storage", async () => {
  const account = fakeAccount();
  const fake = fakeHost();
  fake.store.set("credits/ses_old", 12.4);
  const answer = await run(
    account,
    Effect.gen(function* () {
      const tracker = yield* Usage.make(fake.host);
      yield* tracker.record("ses_old", { credits: 1 });
      yield* settle;
      return yield* fake.ask("ses_old");
    })
  );
  expect(answer.credits.ses_old).toBeCloseTo(13.4);
  expect(fake.store.get("credits/ses_old")).toBeCloseTo(13.4);
});

test("usage: an account Kiro won't show is an error in the answer, not a failure", async () => {
  const account = fakeAccount();
  account.read = Failure.KiroApiError.fromReply(403, '{"message":"Not allowed","reason":null}');
  const fake = fakeHost();
  const answer = await run(
    account,
    Effect.gen(function* () {
      yield* Usage.make(fake.host);
      return yield* fake.ask("ses_x");
    })
  );
  expect(answer).toEqual({
    account: null,
    error: "Kiro: Not allowed (HTTP 403)",
    credits: { ses_x: 0 },
  });
});

test("usage: the account is read again 60 seconds after a read that worked, not sooner", async () => {
  const account = fakeAccount();
  const fake = fakeHost();
  const reads = await run(
    account,
    Effect.gen(function* () {
      yield* Usage.make(fake.host);
      const seen: number[] = [];
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
  expect(reads).toEqual([1, 1, 2]);
});

test("usage: the account is read again 10 seconds after a read that failed", async () => {
  const account = fakeAccount();
  account.read = Failure.KiroApiError.fromReply(500, "");
  const fake = fakeHost();
  const reads = await run(
    account,
    Effect.gen(function* () {
      yield* Usage.make(fake.host);
      const seen: number[] = [];
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
  expect(reads).toEqual([1, 1, 2]);
});

test("usage: a reply ending while the account is being read counts, and starts no second read", async () => {
  const account = fakeAccount();
  const fake = fakeHost();
  const out = await run(
    account,
    Effect.gen(function* () {
      // the read Kiro hasn't answered yet
      const gate = yield* Deferred.make<AccountUsage>();
      account.read = Deferred.await(gate);
      const tracker = yield* Usage.make(fake.host);
      yield* tracker.record("ses_a", { credits: 1 });
      yield* settle;
      yield* tracker.record("ses_a", { credits: 2 });
      yield* settle;
      const during = { reads: account.reads, emitted: [...fake.emitted] };
      yield* Deferred.succeed(gate, ACCOUNT);
      yield* settle;
      return { during, answer: yield* fake.ask("ses_a") };
    })
  );
  expect(out.during).toEqual({ reads: 1, emitted: [] });
  expect(fake.emitted).toEqual(["updated"]);
  expect(account.reads).toBe(1);
  expect(out.answer.credits.ses_a).toBe(3);
});

test("usage: an RPC whose storage read answers late keeps a reply's credits counted meanwhile", async () => {
  const account = fakeAccount();
  const fake = fakeHost();
  fake.store.set("credits/ses_a", 5);
  const answer = await run(
    account,
    Effect.gen(function* () {
      const tracker = yield* Usage.make(fake.host);
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
  expect(answer.credits.ses_a).toBe(6);
  expect(fake.store.get("credits/ses_a")).toBe(8);
});

test("usage: when the RPC can't be registered, replies still count and nothing is emitted", async () => {
  const account = fakeAccount();
  const fake = fakeHost(false);
  await run(
    account,
    Effect.gen(function* () {
      const tracker = yield* Usage.make(fake.host);
      yield* tracker.record("ses_a", { credits: 0.5 });
      yield* settle;
    })
  );
  expect(fake.store.get("credits/ses_a")).toBe(0.5);
  expect(fake.emitted).toEqual([]);
});
