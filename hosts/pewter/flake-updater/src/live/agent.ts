import {
  Agent as AgentSchema,
  AbsolutePath,
  Model,
  OpenCode,
  Session,
} from "@opencode/client/effect";
import type { OpenCodeClient, SessionMessage } from "@opencode/client/effect";
import type { Redacted } from "effect";
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
  String as Str,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Agent, AgentError } from "../agent.ts";
import type { RepairRequest } from "../agent.ts";
import { RepairReport } from "../report.ts";
import { blockedEntries, blockedGlobs } from "../scope.ts";

export interface FixerServerConfig {
  readonly url: string;
  readonly password: Redacted.Redacted;
  /** Agent declared in the server's Nix-generated config. */
  readonly agent: string;
  /** `provider/model`, pinned on every session. */
  readonly model: string;
  readonly workDir: string;
  /** Read-only material for the agent, outside the workspace. */
  readonly contextDir: string;
  readonly roundTimeout: Duration.Duration;
}

export class FixerServer extends Context.Service<
  FixerServer,
  FixerServerConfig
>()("flake-updater/live/agent/FixerServer") {}

const blockedList = Arr.join(blockedEntries, ", ");

const shellAllowed = [
  "nix eval *",
  "nix flake check *",
  "nix flake show *",
  "nix flake metadata *",
  "nix derivation show *",
  "nix log *",
  "nix why-depends *",
  "nix path-info *",
  "flake-updater revert-lock *",
  "cd *",
  "pwd *",
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "rg *",
  "jq *",
  "diff *",
  "sort *",
  "uniq *",
];

type Rule = Readonly<{
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}>;

/**
 * Session rules apply after the agent's own, so these decide. Anything they
 * leave at `ask` is rejected by the Updater; the server's global policies
 * hard-deny the worst cases again.
 */
const sessionRules = (contextDir: string): readonly Rule[] => [
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "secrets/*", effect: "deny" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
  {
    action: "external_directory",
    resource: `${contextDir}/*`,
    effect: "allow",
  },
  { action: "external_directory", resource: "/nix/store/*", effect: "allow" },
  ...Arr.map(shellAllowed, (resource): Rule => ({
    action: "shell",
    resource,
    effect: "allow",
  })),
  { action: "shell", resource: "*--impure*", effect: "deny" },
  ...Arr.map(blockedGlobs, (resource): Rule => ({
    action: "edit",
    resource,
    effect: "deny",
  })),
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
];

const firstRound = (
  request: RepairRequest,
  mainLock: string,
  workDir: string
) =>
  Arr.join(
    [
      `PR #${request.pr}: the weekly flake update fails the Build gate. Make the gate pass.`,
      "",
      `Your workspace, ${workDir}, is a copy of the PR branch. Edit files there. The Updater copies your changes back, commits them, and pushes. Nothing outside the workspace is kept.`,
      "",
      "Inputs this update changed (main → branch):",
      request.changes,
      "",
      `main's flake.lock is at ${mainLock}.`,
      "",
      "Decide what broke:",
      "- If our configuration uses an option, package or function that upstream renamed or removed, fix the configuration. Read the upstream source under /nix/store to confirm the replacement.",
      `- If an input itself is broken, revert it to main's revision by listing it in revertedInputs. Don't edit flake.lock for this: the Updater rewrites flake.lock from that list. To try a revert locally, run \`flake-updater revert-lock --main ${
        mainLock
      } <input>...\` in the workspace.`,
      "- Reverting nixpkgs holds back almost every other input, so prefer a configuration fix. If you do revert nixpkgs, say why in the summary.",
      `- Never change ${blockedList}. The Updater discards any round that does.`,
      "",
      "Before you finish, evaluate from the workspace:",
      "- every host: `nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath` for each name in `nix eval --json .#nixosConfigurations --apply builtins.attrNames`",
      "- the flake checks: `nix flake check --no-build`",
      "Building is the gate's job, so don't run nix build.",
      "",
      "Failing checks, trimmed to the Nix errors:",
      "",
      request.failures,
    ],
    "\n"
  );

const laterRound = (request: RepairRequest) =>
  Arr.join(
    [
      "The Build gate is still red after your last round.",
      ...Option.match(request.feedback, {
        onNone: () => [],
        onSome: (feedback) => ["", feedback],
      }),
      "",
      "The workspace was reset to the branch as pushed. Failing checks:",
      "",
      request.failures,
    ],
    "\n"
  );

const reportPrompt = Arr.join(
  [
    "Reply with only a JSON object describing this round: no prose, no code fence.",
    '{"outcome": "fixed" | "reverted" | "gave-up", "revertedInputs": [names of inputs to put back at main\'s revision], "filesChanged": [workspace-relative paths you changed, not flake.lock], "summary": "a one-line commit subject, then optional detail"}',
  ],
  "\n"
);

const decodeReport = Schema.decodeEffect(Schema.fromJsonString(RepairReport));

/** The JSON object in a reply, tolerating a stray code fence. */
const jsonObject = (text: string) => {
  const start = Str.indexOf("{")(text);
  const end = Str.lastIndexOf("}")(text);

  if (Option.isNone(start) || Option.isNone(end) || end.value < start.value) {
    return text;
  }

  return Str.slice(start.value, end.value + 1)(text);
};

const unavailableTags = [
  "HttpClientError",
  "ServiceUnavailableError",
  "UnauthorizedError",
  "AgentNotFoundError",
];

const toAgentError = (context: string) => (cause: unknown) =>
  AgentError.make({
    reason: Arr.some(unavailableTags, (tag) => Predicate.isTagged(cause, tag))
      ? "unavailable"
      : "failed",
    message: `${context}: ${Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause)}`,
  });

const isIdle = (message: SessionMessage.Info): message is SessionMessage.Idle =>
  message.type === "idle";

const isAssistant = (
  message: SessionMessage.Info
): message is SessionMessage.Assistant => message.type === "assistant";

/** Why a finished round cannot be trusted, if it cannot. */
const roundProblem = (
  messages: readonly SessionMessage.Info[],
  agent: string
): Option.Option<AgentError> => {
  const assistants = Arr.filter(messages, isAssistant);

  if (Arr.some(assistants, (message) => message.agent !== agent)) {
    return Option.some(
      AgentError.make({
        reason: "unavailable",
        message: `the server ran a different agent than ${agent}; check its opencode config`,
      })
    );
  }

  const idle = Arr.last(Arr.filter(messages, isIdle));

  if (Option.isNone(idle) || idle.value.outcome === "succeeded") {
    return Option.none();
  }

  const { error } = idle.value;

  // provider.* covers free-tier limits, auth and unknown models.
  const providerFault =
    error !== undefined && Str.startsWith("provider.")(error.type);

  return Option.some(
    AgentError.make({
      reason: providerFault ? "unavailable" : "failed",
      message: error?.message ?? `the round ended ${idle.value.outcome}`,
    })
  );
};

export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const config = yield* FixerServer;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;

    const authenticated = HttpClient.mapRequest(
      http,
      HttpClientRequest.basicAuth("opencode", config.password)
    );

    const client: OpenCodeClient = yield* OpenCode.make({
      baseUrl: config.url,
    }).pipe(Effect.provideService(HttpClient.HttpClient, authenticated));

    const mainLock = path.join(config.contextDir, "main.flake.lock");

    // Every ask the session rules leave open is rejected: nobody is there to
    // answer, and a rule that should allow it belongs in sessionRules.
    const rejectAsks = (sessionID: Session.ID) =>
      client.event.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "permission.asked" &&
          event.data.sessionID === sessionID
            ? client.permission
                .reply({
                  sessionID,
                  requestID: event.data.id,
                  decision: "reject",
                  message: `${event.data.action} ${Arr.join(event.data.resources, " ")} is not allowed for the Flake fixer.`,
                })
                .pipe(Effect.ignore)
            : Effect.void
        ),
        Effect.ignore
      );

    const openSession = (request: RepairRequest) =>
      Option.match(request.session, {
        onSome: (id) => Effect.succeed(Session.ID.make(id)),
        onNone: () =>
          client.session
            .create({
              title: request.title,
              agent: AgentSchema.ID.make(config.agent),
              model: Model.Ref.parse(config.model),
              location: { directory: AbsolutePath.make(config.workDir) },
              permissions: [...sessionRules(config.contextDir)],
            })
            .pipe(
              Effect.map((session) => session.id),
              Effect.mapError(toAgentError("creating the session"))
            ),
      });

    const roundTimedOut = AgentError.make({
      reason: "failed",
      message: `the round ran past ${Duration.format(config.roundTimeout)}`,
    });

    const runRound = Effect.fn("Agent.runRound")(function* (
      sessionID: Session.ID,
      text: string
    ) {
      yield* Effect.forkScoped(rejectAsks(sessionID));
      yield* client.session
        .prompt({ sessionID, text })
        .pipe(Effect.mapError(toAgentError("sending the prompt")));
      yield* client.session.wait({ sessionID }).pipe(
        Effect.mapError(toAgentError("waiting for the round")),
        Effect.timeoutOrElse({
          duration: config.roundTimeout,
          orElse: () =>
            client.session
              .interrupt({ sessionID })
              .pipe(Effect.ignore, Effect.andThen(roundTimedOut)),
        })
      );
    }, Effect.scoped);

    const checkOutcome = Effect.fn("Agent.checkOutcome")(function* (
      sessionID: Session.ID
    ) {
      const messages = yield* client.session
        .context({ sessionID })
        .pipe(Effect.mapError(toAgentError("reading the session")));

      yield* Option.match(roundProblem(messages, config.agent), {
        onNone: () => Effect.void,
        onSome: Effect.fail,
      });
    });

    const roundReport = Effect.fn("Agent.roundReport")(function* (
      sessionID: Session.ID,
      text: string
    ) {
      yield* runRound(sessionID, text);
      yield* checkOutcome(sessionID);

      const reply = yield* client.session
        .generate({ sessionID, prompt: reportPrompt })
        .pipe(Effect.mapError(toAgentError("asking for the round report")));

      return yield* decodeReport(jsonObject(reply.text)).pipe(
        Effect.mapError(toAgentError("reading the round report"))
      );
    });

    const repair = Effect.fn("Agent.repair")(function* (
      request: RepairRequest
    ) {
      yield* fs
        .makeDirectory(config.contextDir, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(mainLock, request.mainLock)),
          Effect.mapError(toAgentError("writing main's flake.lock"))
        );
      yield* client.server
        .info()
        .pipe(Effect.mapError(toAgentError("reaching the opencode server")));

      const sessionID = yield* openSession(request);

      const text = Option.isNone(request.session)
        ? firstRound(request, mainLock, config.workDir)
        : laterRound(request);

      yield* Effect.log(`Flake fixer round ${request.round} in ${sessionID}`);

      const report = yield* roundReport(sessionID, text).pipe(
        Effect.mapError((error) =>
          AgentError.make({
            reason: error.reason,
            message: error.message,
            session: sessionID,
          })
        )
      );

      return { session: sessionID, report };
    });

    return Agent.of({ repair });
  })
);
