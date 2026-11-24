// The Kiro section of the session sidebar: the account's plan and credits
// this month, and what the session has spent. The server part (index.ts)
// answers over the RPC in rpc.ts, and says when to ask again; sidebar.ts
// says what the answer shows as.

/* oxlint-disable typescript/no-unsafe-return -- Solid's JSX.Element includes DOM's Node, which this package's lib leaves out, so the type-aware lint reads JSX as an error type */

import { Plugin } from "@opencode/plugin/tui";
import { Array as Arr } from "effect";
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
import {
  type Line,
  answerOf,
  lines,
  sessionsCounted,
  shown as isShown,
  unanswered,
} from "./sidebar.ts";

function KiroUsage(props: { context: Plugin.Context; sessionID: string }) {
  const data = props.context.data.session;
  const theme = () => props.context.theme;
  const session = () => data.get(props.sessionID);
  const sessionIDs = createMemo(
    () =>
      sessionsCounted(
        props.sessionID,
        session(),
        data.family(data.root(props.sessionID))
      ),
    undefined,
    {
      equals: (before, now) => Arr.join(before, ",") === Arr.join(now, ","),
    }
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
    )
      .then(answerOf)
      .catch(unanswered);
  const [usage, { refetch }] = createResource(
    () =>
      Arr.join(
        [Arr.join(sessionIDs(), ","), location()?.directory ?? ""],
        "\n"
      ),
    ask
  );

  // Asked again when the server says so, and when a reply ends. The server
  // says so after every reply that ends well, one that cost nothing or
  // whose account read failed too. A reply's end still asks because events
  // can be missed: the subscription is on the client at mount, which a
  // server restart replaces, and a disconnected one misses what is sent.
  const stop = props.context.client
    .rpc(KiroRpc)
    .events.on("updated", () => void refetch());
  onCleanup(stop);
  createEffect(
    on(
      () => data.status(props.sessionID),
      (now, before) => {
        if (before === "running" && now === "idle") {
          void refetch();
        }
      }
    )
  );

  const answer = () => {
    const { latest } = usage;
    return isShown(session()?.model?.providerID, latest, sessionIDs())
      ? latest
      : undefined;
  };
  const colour = (tone: Line["tone"]) =>
    ({
      error: theme().text.feedback.error.base,
      muted: theme().text.muted,
      title: theme().text.base,
    })[tone];

  return (
    <Show when={answer()}>
      {(shown: Accessor<UsageAnswer>) => (
        <box>
          {/* oxlint-disable-next-line effecttsgo/global-date -- Solid view code, outside any Effect, so there is no Clock */}
          <For each={lines(shown(), sessionIDs(), Date.now())}>
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
      render: (input) => (
        <KiroUsage context={context} sessionID={input.sessionID} />
      ),
    });
  },
});
