// What the sidebar shows, as plain data: whose credits a session counts,
// whether the Kiro section shows at all, and its lines for an answer of the
// usage RPC. tui.tsx asks and draws; this file decides.

import { Option, Schema } from "effect";

import { type Allowance, UsageAnswer } from "./rpc.ts";

// what the RPC answers, or why there is no answer

// the client passes the answer on unchecked, and a server still running an
// older plugin checked it against that plugin's schema, not this one
const decodeAnswer = Schema.decodeUnknownOption(UsageAnswer);
// the client throws an Error, or the RPC's own error as a plain object
const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));

// answerOf is what the usage RPC answered, read against this plugin's schema
export const answerOf = (out: unknown): UsageAnswer =>
  Option.getOrElse(decodeAnswer(out), () => ({
    account: null,
    error: "Kiro's usage didn't read as expected",
    credits: {},
  }));

// unanswered is the answer when the usage RPC fails: why, and no credits
export const unanswered = (cause: unknown): UsageAnswer => ({
  account: null,
  error: Option.match(decodeReason(cause), {
    onSome: (e) => e.message,
    onNone: () => String(cause),
  }),
  credits: {},
});

// sessionsCounted is whose credits the sidebar adds up for sessionID. A
// root session counts its whole family, subagents too; a child, itself.
// session is OpenCode's, undefined until it has loaded, and family is its
// root's family.
export function sessionsCounted(
  sessionID: string,
  session: { readonly parentID?: string } | undefined,
  family: readonly string[]
): readonly string[] {
  if (!session || session.parentID) return [sessionID];
  return [...new Set([sessionID, ...family])];
}

// what the sessions counted have spent, from the answer
const creditsOf = (answer: UsageAnswer, sessionIDs: readonly string[]) =>
  sessionIDs.reduce((sum, id) => sum + (answer.credits[id] ?? 0), 0);

// shown is whether the Kiro section shows: once there is an answer, for a
// session on a Kiro model or one whose sessions counted have spent credits.
// providerID is the session's model's.
export function shown(
  providerID: string | undefined,
  answer: UsageAnswer | undefined,
  sessionIDs: readonly string[]
): boolean {
  if (!answer) return false;
  return providerID === "kiro" || creditsOf(answer, sessionIDs) > 0;
}

// Line is one line of the section. The title is drawn bold, an error in
// the theme's error colour, the rest muted.
export interface Line {
  readonly text: string;
  readonly tone: "title" | "muted" | "error";
}

const DAY = 24 * 60 * 60 * 1000;
// one locale throughout: en-GB, for "31 Oct" and "8,978.6"
const amount = (n: number, digits = 1) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(n);
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const day = (ms: number) => dayFormat.format(ms);
// a session's credits are often under one, so they keep two decimals
const spent = (n: number) => amount(n, n < 10 ? 2 : 1);

// "Kiro Pro · resets 31 Oct (3d)"
function planLine(plan: string, resetsAt: number, now: number) {
  if (!resetsAt) return plan;
  const days = Math.max(0, Math.ceil((resetsAt - now) / DAY));
  return `${plan} · resets ${day(resetsAt)} (${days}d)`;
}

function allowanceLines(a: Allowance): Line[] {
  const unit = a.name.toLowerCase();
  // the overage cap when there is one, else the plan's limit
  const cap = a.overage?.cap || a.limit;
  const out: Line[] = [{ text: `${amount(a.used)} / ${amount(cap)} ${unit}`, tone: "muted" }];
  if (a.trial) {
    const ends = a.trial.expiresAt ? ` · ends ${day(a.trial.expiresAt)}` : "";
    out.push({
      text: `Trial ${amount(a.trial.used)} / ${amount(a.trial.limit)} ${unit}${ends}`,
      tone: "muted",
    });
  }
  return out;
}

// lines is the section for answer: the account's plan and allowances when
// it was read, why not when it wasn't, then what the sessions counted have
// spent. now is the time the days to the reset count from.
export function lines(answer: UsageAnswer, sessionIDs: readonly string[], now: number): Line[] {
  const out: Line[] = [{ text: "Kiro", tone: "title" }];
  if (answer.account) {
    out.push({ text: planLine(answer.account.plan, answer.account.resetsAt, now), tone: "muted" });
    for (const a of answer.account.allowances) out.push(...allowanceLines(a));
  }
  if (answer.error) out.push({ text: answer.error, tone: "error" });
  out.push({ text: `Session ${spent(creditsOf(answer, sessionIDs))} credits`, tone: "muted" });
  return out;
}
