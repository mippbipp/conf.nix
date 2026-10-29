// The sidebar's view through src/sidebar.ts: whose credits a session counts,
// and the lines it shows for an answer of the usage RPC. Run with
// BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import { Array as Arr } from "effect";

import type { UsageAnswer } from "../src/rpc.ts";
import * as Sidebar from "../src/sidebar.ts";

test("a root session counts itself and its family, a child only itself", () => {
  expect(Sidebar.sessionsCounted("ses_root", {}, ["ses_root", "ses_a", "ses_b"])).toEqual([
    "ses_root",
    "ses_a",
    "ses_b",
  ]);
  expect(Sidebar.sessionsCounted("ses_root", {}, ["ses_a"])).toEqual(["ses_root", "ses_a"]);
  expect(
    Sidebar.sessionsCounted("ses_a", { parentID: "ses_root" }, ["ses_root", "ses_a", "ses_b"])
  ).toEqual(["ses_a"]);
  // a session OpenCode hasn't loaded yet
  expect(Sidebar.sessionsCounted("ses_new", undefined, [])).toEqual(["ses_new"]);
});

test("the section shows on a Kiro model, or when the sessions counted have spent credits", () => {
  const none: UsageAnswer = { account: null, credits: { ses_a: 0 } };
  const spent: UsageAnswer = { account: null, credits: { ses_a: 0, ses_b: 0.02 } };
  expect(Sidebar.shown("kiro", none, ["ses_a"])).toBe(true);
  expect(Sidebar.shown("anthropic", none, ["ses_a"])).toBe(false);
  expect(Sidebar.shown(undefined, none, ["ses_a"])).toBe(false);
  expect(Sidebar.shown("anthropic", spent, ["ses_a", "ses_b"])).toBe(true);
  // ses_b spent them, and a child counts only itself
  expect(Sidebar.shown("anthropic", spent, ["ses_a"])).toBe(false);
  // nothing to show before the first answer
  expect(Sidebar.shown("kiro", undefined, ["ses_a"])).toBe(false);
});

// 28 Oct 2026, 13:00 UTC. The answers' times are at noon UTC, so their day
// is the same in any time zone from UTC-11 to UTC+11.
const NOW = 1_793_192_400_000;
const ACCOUNT = {
  plan: "Kiro Pro",
  resetsAt: 1_793_448_000_000, // 31 Oct 2026, 12:00 UTC
  allowances: [{ name: "Credits", used: 8978.62, limit: 10_000 }],
  checkedAt: NOW,
};

test("an account's lines: the plan and its reset, each allowance, and the session's credits", () => {
  const answer: UsageAnswer = { account: ACCOUNT, credits: { ses_a: 0.341, ses_b: 1 } };
  expect(Sidebar.lines(answer, ["ses_a", "ses_b"], NOW)).toEqual([
    { text: "Kiro", tone: "title" },
    { text: "Kiro Pro · resets 31 Oct (3d)", tone: "muted" },
    { text: "8,978.6 / 10,000 credits", tone: "muted" },
    { text: "Session 1.34 credits", tone: "muted" },
  ]);
});

test("an allowance over its limit counts up to the overage cap, and a trial has its own line", () => {
  const answer: UsageAnswer = {
    account: {
      ...ACCOUNT,
      allowances: [
        {
          name: "Credit",
          used: 8978.62,
          limit: 1000,
          overage: {
            credits: 7978.62,
            charges: 319.14,
            currency: "USD",
            rate: 0.04,
            cap: 40_000,
            enabled: true,
          },
          trial: { used: 10, limit: 500, expiresAt: 1_793_793_600_000 }, // 4 Nov 2026
        },
        { name: "Spec", used: 3, limit: 50, trial: { used: 0, limit: 5 } },
      ],
    },
    credits: { ses_a: 12.345 },
  };
  expect(Arr.map(Sidebar.lines(answer, ["ses_a"], NOW), (line) => line.text)).toEqual([
    "Kiro",
    "Kiro Pro · resets 31 Oct (3d)",
    "8,978.6 / 40,000 credit",
    "Trial 10 / 500 credit · ends 4 Nov",
    "3 / 50 spec",
    "Trial 0 / 5 spec",
    // ten credits and over keep one decimal
    "Session 12.3 credits",
  ]);
});

test("with overages turned off, an allowance counts up to the plan's limit", () => {
  const answer: UsageAnswer = {
    account: {
      ...ACCOUNT,
      allowances: [
        {
          name: "Credits",
          used: 1200,
          limit: 1000,
          // this month's overage, from before they were turned off
          overage: {
            credits: 200,
            charges: 8,
            currency: "USD",
            rate: 0.04,
            cap: 40_000,
            enabled: false,
          },
        },
      ],
    },
    credits: {},
  };
  expect(Sidebar.lines(answer, [], NOW)[2]?.text).toBe("1,200 / 1,000 credits");
});

test("the days to the reset round up, stop at none, and a reset Kiro didn't say leaves the plan", () => {
  const plan = (resetsAt: number, now: number) =>
    Sidebar.lines({ account: { ...ACCOUNT, resetsAt }, credits: {} }, [], now)[1]?.text;
  // 2.04 days
  expect(plan(ACCOUNT.resetsAt, NOW)).toBe("Kiro Pro · resets 31 Oct (3d)");
  // an hour before
  expect(plan(ACCOUNT.resetsAt, 1_793_444_400_000)).toBe("Kiro Pro · resets 31 Oct (1d)");
  // a day after, before the account is read again
  expect(plan(ACCOUNT.resetsAt, 1_793_534_400_000)).toBe("Kiro Pro · resets 31 Oct (0d)");
  expect(plan(0, NOW)).toBe("Kiro Pro");
});

test("an account that couldn't be read shows why, and the session's credits still", () => {
  const answer: UsageAnswer = {
    account: null,
    error: "Kiro: Not allowed (HTTP 403)",
    credits: { ses_a: 0.091 },
  };
  expect(Sidebar.lines(answer, ["ses_a", "ses_gone"], NOW)).toEqual([
    { text: "Kiro", tone: "title" },
    { text: "Kiro: Not allowed (HTTP 403)", tone: "error" },
    { text: "Session 0.09 credits", tone: "muted" },
  ]);
});

test("what the RPC answers is read against this plugin's schema", () => {
  const answer = { account: ACCOUNT, credits: { ses_a: 1 } };
  expect(Sidebar.answerOf(answer)).toEqual(answer);
  // a server still running an older plugin
  expect(Sidebar.answerOf({ account: { plan: "Kiro Pro" }, credits: {} })).toEqual({
    account: null,
    error: "Kiro's usage didn't read as expected",
    credits: {},
  });
});

test("an RPC that fails answers why", () => {
  const why = (cause: unknown) => Sidebar.unanswered(cause);
  expect(why(new Error("Unable to connect"))).toEqual({
    account: null,
    error: "Unable to connect",
    credits: {},
  });
  // the client throws the RPC's own errors as plain objects
  expect(why({ type: "rpc.not_found", message: "No RPC kiro" }).error).toBe("No RPC kiro");
  expect(why("offline").error).toBe("offline");
});
