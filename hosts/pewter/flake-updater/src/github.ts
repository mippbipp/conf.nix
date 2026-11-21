import type { Effect, Option } from "effect";
import { Context, Schema } from "effect";

export class GitHubError extends Schema.TaggedError<
  GitHubError,
  { readonly brand: unique symbol }
>()("GitHubError", { cause: Schema.Defect(), message: Schema.String }) {}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
}

export interface Issue {
  readonly body: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

export interface PullRequestUpdate {
  readonly body: string;
  /**
   * Turns auto-merge off and adds the `ready-for-human` label; otherwise
   * auto-merge is on and the label is removed.
   */
  readonly needsReview: boolean;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly closeIssue: (
      issue: Issue,
      comment: string
    ) => Effect.Effect<void, GitHubError>;
    readonly commentIssue: (
      issue: Issue,
      body: string
    ) => Effect.Effect<void, GitHubError>;
    readonly createIssue: (
      title: string,
      body: string
    ) => Effect.Effect<Issue, GitHubError>;
    readonly createPr: (
      title: string,
      body: string
    ) => Effect.Effect<PullRequest, GitHubError>;
    /**
     * Turns auto-merge off and confirms it is off, so a commit that needs
     * review can be pushed without the Build gate merging it.
     */
    readonly holdForReview: (
      pr: PullRequest
    ) => Effect.Effect<void, GitHubError>;
    /** Open issues labelled `automated`. */
    readonly openIssues: Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    readonly openPr: Effect.Effect<Option.Option<PullRequest>, GitHubError>;
    readonly updatePr: (
      pr: PullRequest,
      update: PullRequestUpdate
    ) => Effect.Effect<void, GitHubError>;
  }
>()("flake-updater/github") {}
