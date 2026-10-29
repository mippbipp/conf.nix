// The Kiro section of the session sidebar: the account's plan and credits
// this month, and what the session has spent. The server part (index.ts)
// answers over the RPC in rpc.ts, and says when to ask again; sidebar.ts
// says what the answer shows as.

import { Plugin } from "@opencode/plugin/tui";
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

import { KiroRpc, type UsageAnswer } from "./rpc.ts";
import * as Sidebar from "./sidebar.ts";

function KiroUsage(props: { context: Plugin.Context; sessionID: string }) {
  const data = props.context.data.session;
  const theme = () => props.context.theme;
  const session = () => data.get(props.sessionID);
  const sessionIDs = createMemo(
    () =>
      Sidebar.sessionsCounted(props.sessionID, session(), data.family(data.root(props.sessionID))),
    undefined,
    { equals: (before, now) => before.join(",") === now.join(",") }
  );
  const location = createMemo(() => session()?.location, undefined, {
    equals: (before, now) => before?.directory === now?.directory,
  });

  // the client changes when the server restarts, so it is read each time
  const ask = () =>
    Promise.try(() =>
      props.context.client
        .rpc(KiroRpc)
        .usage({ sessionIDs: [...sessionIDs()] }, { location: location() })
    ).then(Sidebar.answerOf, Sidebar.unanswered);
  const [usage, { refetch }] = createResource(
    () => [sessionIDs().join(","), location()?.directory ?? ""].join("\n"),
    ask
  );

  // Asked again when the server says so, and when a reply ends. The server
  // says so after every reply that ends well, one that cost nothing or
  // whose account read failed too. A reply's end still asks because events
  // can be missed: the subscription is on the client at mount, which a
  // server restart replaces, and a disconnected one misses what is sent.
  const stop = props.context.client.rpc(KiroRpc).events.on("updated", () => void refetch());
  onCleanup(stop);
  createEffect(
    on(
      () => data.status(props.sessionID),
      (now, before) => {
        if (before === "running" && now === "idle") void refetch();
      }
    )
  );

  const answer = () => {
    const latest = usage.latest;
    return Sidebar.shown(session()?.model?.providerID, latest, sessionIDs()) ? latest : undefined;
  };
  const colour = (tone: Sidebar.Line["tone"]) =>
    ({
      title: theme().text.base,
      muted: theme().text.muted,
      error: theme().text.feedback.error.base,
    })[tone];

  return (
    <Show when={answer()}>
      {(shown: Accessor<UsageAnswer>) => (
        <box>
          <For each={Sidebar.lines(shown(), sessionIDs(), Date.now())}>
            {(line) => (
              <text fg={colour(line.tone)}>
                {line.tone === "title" ? <b>{line.text}</b> : line.text}
              </text>
            )}
          </For>
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
