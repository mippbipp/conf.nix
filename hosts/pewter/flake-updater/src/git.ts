import { Context, Effect, Schema } from "effect";

import { parseLock } from "./lock.ts";

export class GitError extends Schema.TaggedError<
  GitError,
  { readonly brand: unique symbol }
>()("GitError", { message: Schema.String, cause: Schema.Defect() }) {}

/**
 * How the local `flake-update` branch was rebuilt for this run:
 * - `fresh`: no open PR, so the branch starts over from main.
 * - `continued`: the open PR's branch with main merged in.
 * - `reset`: main conflicted with the PR's code commits, which were dropped.
 */
export interface SyncOutcome {
  readonly mode: "fresh" | "continued" | "reset";
  readonly dropped: readonly string[];
}

export interface BranchCommit {
  readonly sha: string;
  readonly message: string;
}

/** A tree object built from the Flake fixer's workspace. */
export interface ImportedTree {
  readonly tree: string;
  /** Paths that differ from HEAD. */
  readonly files: readonly string[];
  /** Of `files`, those that are gitlinks added or moved by the workspace. */
  readonly gitlinks: readonly string[];
}

export const mainRef = "origin/main";

/**
 * The Updater's checkout. Only this service runs git, and never inside a
 * directory the Flake fixer can write.
 */
export class Git extends Context.Service<
  Git,
  {
    /** Clone if needed, configure auth and identity, fetch origin. */
    readonly prepare: Effect.Effect<void, GitError>;
    readonly sync: (
      continuing: boolean
    ) => Effect.Effect<SyncOutcome, GitError>;
    /** Commits flake.lock when `nix flake update` changed it. */
    readonly commitLock: (message: string) => Effect.Effect<boolean, GitError>;
    readonly readLock: (rev: string) => Effect.Effect<string, GitError>;
    readonly head: Effect.Effect<string, GitError>;
    /** Non-merge commits on the branch that main does not have. */
    readonly branchCommits: Effect.Effect<readonly BranchCommit[], GitError>;
    readonly changedFromMain: Effect.Effect<readonly string[], GitError>;
    /** `replace` rewrites the remote branch (with lease); otherwise fast-forward. */
    readonly push: (replace: boolean) => Effect.Effect<void, GitError>;
    /** Replaces `dir` with a plain copy of HEAD's tree. */
    readonly exportTree: (dir: string) => Effect.Effect<void, GitError>;
    /** Builds a tree from `dir`, with flake.lock forced to `lock`. */
    readonly importTree: (
      dir: string,
      lock: string
    ) => Effect.Effect<ImportedTree, GitError>;
    /** Commits `tree` on top of HEAD and moves the branch to it. */
    readonly commitTree: (
      tree: string,
      message: string
    ) => Effect.Effect<string, GitError>;
  }
>()("flake-updater/git") {}

/** flake.lock at `rev`, parsed. */
export const readFlakeLock = Effect.fn("Git.readFlakeLock")(function* (
  rev: string
) {
  const git = yield* Git;

  return yield* parseLock(yield* git.readLock(rev));
});
