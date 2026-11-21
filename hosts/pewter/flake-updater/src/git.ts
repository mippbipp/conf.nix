import { Context, Effect, Schema } from "effect";

import { parseLock } from "./lock.ts";

export class GitError extends Schema.TaggedError<
  GitError,
  { readonly brand: unique symbol }
>()("GitError", { cause: Schema.Defect(), message: Schema.String }) {}

/**
 * How the local `flake-update` branch was rebuilt for this run:
 * - `fresh`: no open PR, so the branch starts over from main.
 * - `continued`: the open PR's branch with main merged in.
 * - `reset`: main conflicted with the PR's code commits, which were dropped.
 */
export interface SyncOutcome {
  readonly dropped: ReadonlyArray<string>;
  readonly mode: "fresh" | "continued" | "reset";
}

export interface BranchCommit {
  readonly message: string;
  readonly sha: string;
}

/** A tree object built from the Flake fixer's workspace. */
export interface ImportedTree {
  /** Paths that differ from HEAD. */
  readonly files: ReadonlyArray<string>;
  /** Of `files`, those that are gitlinks added or moved by the workspace. */
  readonly gitlinks: ReadonlyArray<string>;
  readonly tree: string;
}

export const mainRef = "origin/main";

/**
 * The Updater's checkout. Only this service runs git, and never inside a
 * directory the Flake fixer can write.
 */
export class Git extends Context.Service<
  Git,
  {
    /** Non-merge commits on the branch that main does not have, oldest first. */
    readonly branchCommits: Effect.Effect<
      ReadonlyArray<BranchCommit>,
      GitError
    >;
    readonly changedFromMain: Effect.Effect<ReadonlyArray<string>, GitError>;
    /** Commits flake.lock when `nix flake update` changed it. */
    readonly commitLock: (message: string) => Effect.Effect<boolean, GitError>;
    /** Commits `tree` on top of HEAD and moves the branch to it. */
    readonly commitTree: (
      tree: string,
      message: string
    ) => Effect.Effect<string, GitError>;
    /** Replaces `dir` with a plain copy of HEAD's tree. */
    readonly exportTree: (dir: string) => Effect.Effect<void, GitError>;
    readonly head: Effect.Effect<string, GitError>;
    /** Builds a tree from `dir`, with flake.lock forced to `lock`. */
    readonly importTree: (
      dir: string,
      lock: string
    ) => Effect.Effect<ImportedTree, GitError>;
    /** Clone if needed, configure auth and identity, fetch origin. */
    readonly prepare: Effect.Effect<void, GitError>;
    /** `replace` rewrites the remote branch (with lease); otherwise fast-forward. */
    readonly push: (replace: boolean) => Effect.Effect<void, GitError>;
    readonly readLock: (rev: string) => Effect.Effect<string, GitError>;
    readonly sync: (
      continuing: boolean
    ) => Effect.Effect<SyncOutcome, GitError>;
  }
>()("flake-updater/git") {}

/** flake.lock at `rev`, parsed. */
export const readFlakeLock = Effect.fn("Git.readFlakeLock")(function* (
  rev: string
) {
  const git = yield* Git;

  const raw = yield* git.readLock(rev);

  return yield* parseLock(raw);
});
