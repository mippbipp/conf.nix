// The sidebar's view through src/sidebar.ts: whose credits a session counts,
// and the lines it shows for an answer of the usage RPC.

import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";

import type { UsageAnswer } from "../src/rpc.ts";
import {
  answerOf,
  lines,
  sessionsCounted,
  shown,
  unanswered,
} from "../src/sidebar.ts";

describe("the sidebar", () => {
  it.effect(
    "a root session counts itself and its family, a child only itself",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          sessionsCounted("ses_root", {}, ["ses_root", "ses_a", "ses_b"]),
          ["ses_root", "ses_a", "ses_b"]
        );
        assert.deepStrictEqual(sessionsCounted("ses_root", {}, ["ses_a"]), [
          "ses_root",
          "ses_a",
        ]);
        assert.deepStrictEqual(
          sessionsCounted("ses_a", { parentID: "ses_root" }, [
            "ses_root",
            "ses_a",
            "ses_b",
          ]),
          ["ses_a"]
        );
        // a session OpenCode hasn't loaded yet
        assert.deepStrictEqual(sessionsCounted("ses_new", undefined, []), [
          "ses_new",
        ]);
      })
  );

  it.effect(
    "the section shows on a Kiro model, or when the sessions counted have spent credits",
    () =>
      Effect.sync(() => {
        const none: UsageAnswer = { account: null, credits: { ses_a: 0 } };
        const spent: UsageAnswer = {
          account: null,
          credits: { ses_a: 0, ses_b: 0.02 },
        };
        assert.isTrue(shown("kiro", none, ["ses_a"]));
        assert.isFalse(shown("anthropic", none, ["ses_a"]));
        assert.isFalse(shown(undefined, none, ["ses_a"]));
        assert.isTrue(shown("anthropic", spent, ["ses_a", "ses_b"]));
        // ses_b spent them, and a child counts only itself
        assert.isFalse(shown("anthropic", spent, ["ses_a"]));
        // nothing to show before the first answer
        assert.isFalse(shown("kiro", undefined, ["ses_a"]));
      })
  );

  // 28 Oct 2026, 13:00 UTC. The answers' times are at noon UTC, so their day
  // is the same in any time zone from UTC-11 to UTC+11.
  const NOW = 1_793_192_400_000;
  const ACCOUNT = {
    allowances: [{ limit: 10_000, name: "Credits", used: 8978.62 }],
    checkedAt: NOW,
    plan: "Kiro Pro",
    resetsAt: 1_793_448_000_000, // 31 Oct 2026, 12:00 UTC
  };

  it.effect(
    "an account's lines: the plan and its reset, each allowance, and the session's credits",
    () =>
      Effect.sync(() => {
        const answer: UsageAnswer = {
          account: ACCOUNT,
          credits: { ses_a: 0.341, ses_b: 1 },
        };
        assert.deepStrictEqual(lines(answer, ["ses_a", "ses_b"], NOW), [
          { text: "Kiro", tone: "title" },
          { text: "Kiro Pro · resets 31 Oct (3d)", tone: "muted" },
          { text: "8,978.6 / 10,000 credits", tone: "muted" },
          { text: "Session 1.34 credits", tone: "muted" },
        ]);
      })
  );

  it.effect(
    "an allowance over its limit counts up to the overage cap, and a trial has its own line",
    () =>
      Effect.sync(() => {
        const answer: UsageAnswer = {
          account: {
            ...ACCOUNT,
            allowances: [
              {
                limit: 1000,
                name: "Credit",
                overage: {
                  cap: 40_000,
                  charges: 319.14,
                  credits: 7978.62,
                  currency: "USD",
                  enabled: true,
                  rate: 0.04,
                },
                trial: { expiresAt: 1_793_793_600_000, limit: 500, used: 10 }, // 4 Nov 2026
                used: 8978.62,
              },
              {
                limit: 50,
                name: "Spec",
                trial: { limit: 5, used: 0 },
                used: 3,
              },
            ],
          },
          credits: { ses_a: 12.345 },
        };
        assert.deepStrictEqual(
          Arr.map(lines(answer, ["ses_a"], NOW), (line) => line.text),
          [
            "Kiro",
            "Kiro Pro · resets 31 Oct (3d)",
            "8,978.6 / 40,000 credit",
            "Trial 10 / 500 credit · ends 4 Nov",
            "3 / 50 spec",
            "Trial 0 / 5 spec",
            // ten credits and over keep one decimal
            "Session 12.3 credits",
          ]
        );
      })
  );

  it.effect(
    "with overages turned off, an allowance counts up to the plan's limit",
    () =>
      Effect.sync(() => {
        const answer: UsageAnswer = {
          account: {
            ...ACCOUNT,
            allowances: [
              {
                limit: 1000,
                name: "Credits",
                used: 1200,
                // this month's overage, from before they were turned off
                overage: {
                  cap: 40_000,
                  charges: 8,
                  credits: 200,
                  currency: "USD",
                  enabled: false,
                  rate: 0.04,
                },
              },
            ],
          },
          credits: {},
        };
        assert.strictEqual(
          lines(answer, [], NOW)[2]?.text,
          "1,200 / 1,000 credits"
        );
      })
  );

  it.effect(
    "the days to the reset round up, stop at none, and a reset Kiro didn't say leaves the plan",
    () =>
      Effect.sync(() => {
        const plan = (resetsAt: number, now: number) =>
          lines({ account: { ...ACCOUNT, resetsAt }, credits: {} }, [], now)[1]
            ?.text;
        // 2.04 days
        assert.strictEqual(
          plan(ACCOUNT.resetsAt, NOW),
          "Kiro Pro · resets 31 Oct (3d)"
        );
        // an hour before
        assert.strictEqual(
          plan(ACCOUNT.resetsAt, 1_793_444_400_000),
          "Kiro Pro · resets 31 Oct (1d)"
        );
        // a day after, before the account is read again
        assert.strictEqual(
          plan(ACCOUNT.resetsAt, 1_793_534_400_000),
          "Kiro Pro · resets 31 Oct (0d)"
        );
        assert.strictEqual(plan(0, NOW), "Kiro Pro");
      })
  );

  it.effect(
    "an account that couldn't be read shows why, and the session's credits still",
    () =>
      Effect.sync(() => {
        const answer: UsageAnswer = {
          account: null,
          credits: { ses_a: 0.091 },
          error: "Kiro: Not allowed (HTTP 403)",
        };
        assert.deepStrictEqual(lines(answer, ["ses_a", "ses_gone"], NOW), [
          { text: "Kiro", tone: "title" },
          { text: "Kiro: Not allowed (HTTP 403)", tone: "error" },
          { text: "Session 0.09 credits", tone: "muted" },
        ]);
      })
  );

  it.effect("what the RPC answers is read against this plugin's schema", () =>
    Effect.sync(() => {
      const answer = { account: ACCOUNT, credits: { ses_a: 1 } };
      assert.deepStrictEqual(answerOf(answer), answer);
      // a server still running an older plugin
      assert.deepStrictEqual(
        answerOf({ account: { plan: "Kiro Pro" }, credits: {} }),
        {
          account: null,
          credits: {},
          error: "Kiro's usage didn't read as expected",
        }
      );
    })
  );

  it.effect("an RPC that fails answers why", () =>
    Effect.sync(() => {
      const why = unanswered;
      assert.deepStrictEqual(why(new Error("Unable to connect")), {
        account: null,
        credits: {},
        error: "Unable to connect",
      });
      // the client throws the RPC's own errors as plain objects
      assert.strictEqual(
        why({ message: "No RPC kiro", type: "rpc.not_found" }).error,
        "No RPC kiro"
      );
      assert.strictEqual(why("offline").error, "offline");
    })
  );
});
