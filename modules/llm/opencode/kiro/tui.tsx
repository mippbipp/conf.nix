// The Kiro section of the session sidebar: the account's plan and credits
// this month, and what the session has spent. The server part (index.ts)
// answers over the RPC in rpc.ts, and says when to ask again.
import { Option, Schema } from "effect";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { type AccountUsage, type Allowance, KiroRpc, UsageAnswer } from "./rpc.ts";

const decodeAnswer = Schema.decodeUnknownOption(UsageAnswer);

const DAY = 24 * 60 * 60 * 1000;
const amount = (n: number, digits = 1) =>
  n.toLocaleString("en-US", { maximumFractionDigits: digits });
const money = (n: number, currency: string) => {
  try {
    return n.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return `${amount(n, 2)} ${currency}`;
  }
};
const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
// a session's credits are often under one, so they keep two decimals
const spent = (n: number) => amount(n, n < 10 ? 2 : 1);

// "Kiro Pro · resets 31 Oct (3d)"
function planLine(plan: string, resetsAt: number) {
  if (!resetsAt) return plan;
  const days = Math.max(0, Math.ceil((resetsAt - Date.now()) / DAY));
  return `${plan} · resets ${day(resetsAt)} (${days}d)`;
}

function KiroUsage(props: { context: Plugin.Context; sessionID: string }) {
  const data = props.context.data.session;
  const theme = () => props.context.theme;
  const session = () => data.get(props.sessionID);
  // a root session counts its whole family, subagents too; a child, itself
  const sessionIDs = createMemo(
    () => {
      const s = session();
      if (!s || s.parentID) return [props.sessionID];
      return [...new Set([props.sessionID, ...data.family(data.root(props.sessionID))])];
    },
    undefined,
    { equals: (a, b) => a.join() === b.join() },
  );
  const location = createMemo(() => session()?.location, undefined, {
    equals: (a, b) => a?.directory === b?.directory,
  });

  const ask = async (): Promise<UsageAnswer> => {
    try {
      // the client changes when the server restarts, so it is read each time
      const out = await props.context.client
        .rpc(KiroRpc)
        .usage({ sessionIDs: sessionIDs() }, { location: location() });
      return Option.getOrElse(decodeAnswer(out), () => ({
        account: null,
        error: "Kiro's usage didn't read as expected",
        credits: {},
      }));
    } catch (e) {
      return { account: null, error: (e instanceof Error && e.message) || String(e), credits: {} };
    }
  };
  const [usage, { refetch }] = createResource(
    () => [sessionIDs().join(), location()?.directory ?? ""].join("\n"),
    ask,
  );

  // asked again when the server says so, and when a reply ends
  const stop = props.context.client.rpc(KiroRpc).events.on("updated", () => void refetch());
  onCleanup(stop);
  createEffect(
    on(
      () => data.status(props.sessionID),
      (now, before) => {
        if (before === "running" && now === "idle") void refetch();
      },
    ),
  );

  const credits = () => {
    const c = usage.latest?.credits ?? {};
    return sessionIDs().reduce((sum, id) => sum + (c[id] ?? 0), 0);
  };
  const shown = () => session()?.model?.providerID === "kiro" || credits() > 0;

  const allowanceLines = (a: Allowance) => {
    const unit = a.name.toLowerCase();
    return (
      <>
        <text fg={theme().text.muted}>
          {amount(a.used)} / {amount(a.limit)} {unit}
        </text>
        <Show when={a.overage && a.overage.credits > 0 ? a.overage : undefined}>
          {(o: Accessor<NonNullable<Allowance["overage"]>>) => (
            <text fg={theme().text.feedback.warning.base}>
              Overage {amount(o().credits)} · {money(o().charges, o().currency)}
              <br />
              {o().cap ? `(cap ${amount(o().cap)})` : ""}
            </text>
          )}
        </Show>
        <Show when={a.trial}>
          {(t: Accessor<NonNullable<Allowance["trial"]>>) => (
            <text fg={theme().text.muted}>
              Trial {amount(t().used)} / {amount(t().limit)} {unit}
              {t().expiresAt ? ` · ends ${day(t().expiresAt!)}` : ""}
            </text>
          )}
        </Show>
      </>
    );
  };

  return (
    <Show when={shown() && usage.latest}>
      {(u: Accessor<UsageAnswer>) => (
        <box>
          <text fg={theme().text.base}>
            <b>Kiro</b>
          </text>
          <Show when={u().account}>
            {(a: Accessor<AccountUsage>) => (
              <>
                <text fg={theme().text.muted}>{planLine(a().plan, a().resetsAt)}</text>
                <For each={a().allowances}>{allowanceLines}</For>
              </>
            )}
          </Show>
          <Show when={u().error}>
            {(e: Accessor<string>) => <text fg={theme().text.feedback.error.base}>{e()}</text>}
          </Show>
          <text fg={theme().text.muted}>Session {spent(credits())} credits</text>
        </box>
      )}
    </Show>
  );
}

export default Plugin.define({
  id: "kiro.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <KiroUsage context={context} sessionID={input.sessionID} />,
    });
  },
});
