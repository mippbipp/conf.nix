import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { run } from "../src/blocklist.ts";
import { ClankwallError } from "../src/clankwall.ts";
import { XRequestError } from "../src/x-session.ts";
import {
  account,
  FakeClankwall,
  FakeX,
  layers,
  settingsLayer,
} from "./fakes.ts";

const runIn = (x: FakeX, clankwall: FakeClankwall, settings = {}) =>
  Effect.gen(function* () {
    const fiber = yield* run().pipe(
      Effect.provide([...layers(x, clankwall), settingsLayer(settings)]),
      Effect.forkChild
    );

    yield* TestClock.adjust("1 day");

    return yield* Fiber.join(fiber);
  });

const requests = (x: FakeX) =>
  Arr.map(x.requests, (request) => `${request.kind} ${request.handle}`);

describe("a blocklist run", () => {
  it.effect("blocks flagged accounts and unblocks everyone else", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("kept"), account("cleared")]);
      const clankwall = new FakeClankwall([account("kept"), account("new")]);

      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(requests(x), ["block new", "unblock cleared"]);
      assert.deepStrictEqual(
        Arr.map(report.actions, (action) => [action.kind, action.confirmed]),
        [
          ["block", true],
          ["unblock", true],
        ]
      );
      assert.deepStrictEqual(x.blockedHandles(), ["kept", "new"]);
    })
  );

  it.effect("changes nothing on a second run", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("cleared")]);
      const clankwall = new FakeClankwall([account("new")]);

      yield* runIn(x, clankwall);
      x.requests.length = 0;
      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(x.requests, []);
      assert.deepStrictEqual(report.pending, { block: 0, unblock: 0 });
    })
  );

  it.effect("reads every page of both lists", () =>
    Effect.gen(function* () {
      const flagged = Arr.makeBy(250, (index) => account(`f${index}`));
      const x = new FakeX([...Arr.take(flagged, 249), account("old")]);
      const clankwall = new FakeClankwall(flagged);

      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(requests(x), ["block f249", "unblock old"]);
      assert.strictEqual(report.flagged, 250);
      assert.strictEqual(report.blockedBefore, 250);
      assert.strictEqual(x.pageReads, 3);
      assert.strictEqual(clankwall.pageReads, 3);
    })
  );

  it.effect("sends nothing in a dry run and reports what it would do", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("cleared")]);
      const clankwall = new FakeClankwall([account("a"), account("b")]);

      const report = yield* runIn(x, clankwall, { dryRun: true });

      assert.deepStrictEqual(x.requests, []);
      assert.deepStrictEqual(report.pending, { block: 2, unblock: 1 });
    })
  );

  it.effect("waits at least the minimum pause between requests", () =>
    Effect.gen(function* () {
      const x = new FakeX([]);
      const clankwall = new FakeClankwall([account("a"), account("b")]);

      const fiber = yield* run().pipe(
        Effect.provide([
          ...layers(x, clankwall),
          settingsLayer({ pause: { min: 4000, max: 4000 } }),
        ]),
        Effect.forkChild
      );

      yield* TestClock.adjust("3999 millis");
      assert.deepStrictEqual(requests(x), ["block a"]);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(requests(x), ["block a", "block b"]);
    })
  );

  it.effect.each([401, 403, 429])(
    "stops when X answers %d and reports it",
    (status) =>
      Effect.gen(function* () {
        const x = new FakeX([account("old")]);
        const clankwall = new FakeClankwall([account("a"), account("b")]);

        x.status.set("b", status);

        const report = yield* runIn(x, clankwall);

        assert.deepStrictEqual(requests(x), ["block a", "block b"]);
        assert.deepStrictEqual(report.stoppedAt, Option.some(status));
        assert.deepStrictEqual(report.pending, { block: 1, unblock: 1 });
      })
  );

  it.effect("carries on past other failed requests", () =>
    Effect.gen(function* () {
      const x = new FakeX([]);
      const clankwall = new FakeClankwall([account("gone"), account("b")]);

      x.status.set("gone", 404);

      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(requests(x), ["block gone", "block b"]);
      assert.deepStrictEqual(report.stoppedAt, Option.none());
      assert.deepStrictEqual(report.pending, { block: 1, unblock: 0 });
    })
  );

  it.effect("counts only changes X confirms for the right account", () =>
    Effect.gen(function* () {
      const x = new FakeX([]);
      const clankwall = new FakeClankwall([account("a"), account("b")]);

      x.answeredAs.set("b", { id: "id-someone_else", handle: "b" });

      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(
        Arr.map(report.actions, (action) => [action.handle, action.confirmed]),
        [
          ["a", true],
          ["b", false],
        ]
      );
      assert.deepStrictEqual(report.pending, { block: 1, unblock: 0 });
    })
  );

  it.effect("confirms by account ID, whatever handle X answers with", () =>
    Effect.gen(function* () {
      const x = new FakeX([]);
      // Clankwall lowercases usernames and can hold an old one.
      const clankwall = new FakeClankwall([account("someone")]);

      x.answeredAs.set("someone", { id: "id-someone", handle: "SomeOne_2" });

      const report = yield* runIn(x, clankwall);

      assert.deepStrictEqual(
        Arr.map(report.actions, (action) => action.confirmed),
        [true]
      );
    })
  );

  it.effect("fails without changes when X's blocked list can't be read", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("old")]);
      const clankwall = new FakeClankwall([account("a")]);

      x.blockedStatus = 401;

      const error = yield* runIn(x, clankwall).pipe(Effect.flip);

      assert.instanceOf(error, XRequestError);
      assert.deepStrictEqual(x.requests, []);
    })
  );

  it.effect("fails without changes when Clankwall can't be read", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("old")]);
      const clankwall = new FakeClankwall([account("a")]);

      clankwall.status = 503;

      const error = yield* runIn(x, clankwall).pipe(Effect.flip);

      assert.instanceOf(error, ClankwallError);
      assert.deepStrictEqual(x.requests, []);
    })
  );

  it.effect("refuses to unblock everyone when Clankwall lists nobody", () =>
    Effect.gen(function* () {
      const x = new FakeX([account("old")]);
      const clankwall = new FakeClankwall([]);

      const error = yield* runIn(x, clankwall).pipe(Effect.flip);

      assert.instanceOf(error, ClankwallError);
      assert.deepStrictEqual(x.requests, []);
    })
  );
});
