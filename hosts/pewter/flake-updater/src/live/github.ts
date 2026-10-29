import type { Option } from "effect";
import {
  Array as Arr,
  Effect,
  Layer,
  Redacted,
  Schema,
  String as Str,
} from "effect";

import { Shell } from "../command.ts";
import { GitHub, GitHubError } from "../github.ts";
import type { Issue, PullRequest, PullRequestUpdate } from "../github.ts";
import { Host } from "../settings.ts";

const PullRequestJson = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
});

const AutoMergeJson = Schema.Struct({
  autoMergeRequest: Schema.NullOr(Schema.Unknown),
});

const IssueJson = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
});

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeEffect(Schema.fromJsonString(schema));

const issueNumber = /\/issues\/(?<number>\d+)$/u;

const fail = (message: string) => (cause: unknown) =>
  GitHubError.make({ message, cause });

const describe = (args: readonly string[]) =>
  `gh ${Arr.join(Arr.take(args, 2), " ")}`;

export const layer = Layer.effect(
  GitHub,
  Effect.gen(function* () {
    const host = yield* Host;
    const { run } = yield* Shell;
    const env = { GH_TOKEN: Redacted.value(host.token) };

    const gh = (args: readonly string[]) => {
      const toError = fail(describe(args));

      return run("gh", [...args, "--repo", host.repo], { env }).pipe(
        Effect.mapError(toError)
      );
    };

    // Dry runs read GitHub for real and only log what they would change.
    const write = (
      description: string,
      effect: Effect.Effect<void, GitHubError>
    ) => (host.dryRun ? Effect.log(`dry-run: would ${description}`) : effect);

    const openPr = gh([
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      "flake-update",
      "--json",
      "number,url",
    ]).pipe(
      Effect.flatMap((output) =>
        decodeJson(Schema.Array(PullRequestJson))(output).pipe(
          Effect.mapError(fail("reading the open PR"))
        )
      ),
      Effect.map((prs): Option.Option<PullRequest> => Arr.head(prs))
    );

    const createPr = Effect.fn("GitHub.createPr")(function* (
      title: string,
      body: string
    ) {
      if (host.dryRun) {
        yield* Effect.log(`dry-run: would open PR "${title}"`);

        return { number: 0, url: "(dry run)" };
      }

      yield* gh([
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "flake-update",
        "--title",
        title,
        "--body",
        body,
        "--label",
        "dependencies",
        "--label",
        "automated",
      ]);

      const created = yield* openPr;

      return yield* Effect.fromOption(created).pipe(
        Effect.mapError(fail("finding the PR it just opened"))
      );
    });

    const holdForReview = Effect.fn("GitHub.holdForReview")(function* (
      pr: PullRequest
    ) {
      const number = `${pr.number}`;

      if (host.dryRun) {
        yield* Effect.log(`dry-run: would turn auto-merge off on #${number}`);

        return;
      }

      // Fails when auto-merge was never on, so read the PR back instead.
      yield* gh(["pr", "merge", number, "--disable-auto"]).pipe(
        Effect.catchTag("GitHubError", () => Effect.void)
      );

      const state = yield* gh([
        "pr",
        "view",
        number,
        "--json",
        "autoMergeRequest",
      ]).pipe(
        Effect.flatMap((output) =>
          decodeJson(AutoMergeJson)(output).pipe(
            Effect.mapError(fail("reading the PR's auto-merge state"))
          )
        )
      );

      yield* Effect.when(
        Effect.fail(
          GitHubError.make({
            message: `auto-merge is still on for #${number}`,
            cause: null,
          })
        ),
        Effect.succeed(state.autoMergeRequest !== null)
      );
    });

    const updatePr = Effect.fn("GitHub.updatePr")(function* (
      pr: PullRequest,
      update: PullRequestUpdate
    ) {
      const number = `${pr.number}`;

      if (host.dryRun) {
        yield* Effect.log(
          `dry-run: PR body would be:\n${update.body}\n(auto-merge ${update.needsReview ? "off" : "on"})`
        );

        return;
      }

      yield* gh(["pr", "edit", number, "--body", update.body]);

      if (update.needsReview) {
        yield* gh(["pr", "edit", number, "--add-label", "ready-for-human"]);
      } else {
        // Fails when the label is absent, which is the state we want.
        yield* gh([
          "pr",
          "edit",
          number,
          "--remove-label",
          "ready-for-human",
        ]).pipe(Effect.catchTag("GitHubError", () => Effect.void));
      }

      // Auto-merge still waits for every required gate check; squash keeps
      // main to one commit per update.
      if (update.needsReview) {
        yield* holdForReview(pr);
      } else {
        yield* gh(["pr", "merge", number, "--auto", "--squash"]);
      }
    });

    const openIssues = gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "automated",
      "--limit",
      "100",
      "--json",
      "number,title,body,url",
    ]).pipe(
      Effect.flatMap((output) =>
        decodeJson(Schema.Array(IssueJson))(output).pipe(
          Effect.mapError(fail("reading open issues"))
        )
      )
    );

    const createIssue = Effect.fn("GitHub.createIssue")(function* (
      title: string,
      body: string
    ) {
      if (host.dryRun) {
        yield* Effect.log(`dry-run: would open issue "${title}":\n${body}`);

        return { number: 0, title, body, url: "(dry run)" };
      }

      const url = Str.trim(
        yield* gh([
          "issue",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--label",
          "needs-triage",
          "--label",
          "automated",
        ])
      );

      const number = Number(issueNumber.exec(url)?.groups?.number ?? "0");

      return { number, title, body, url } satisfies Issue;
    });

    const commentIssue = (issue: Issue, body: string) =>
      write(
        `comment on "${issue.title}":\n${body}`,
        Effect.asVoid(
          gh(["issue", "comment", `${issue.number}`, "--body", body])
        )
      );

    const closeIssue = (issue: Issue, comment: string) =>
      write(
        `close "${issue.title}": ${comment}`,
        Effect.asVoid(
          gh(["issue", "close", `${issue.number}`, "--comment", comment])
        )
      );

    return GitHub.of({
      openPr,
      createPr,
      updatePr,
      holdForReview,
      openIssues,
      createIssue,
      commentIssue,
      closeIssue,
    });
  })
);
