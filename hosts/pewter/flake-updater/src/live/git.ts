import {
  Array as Arr,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  String as Str,
} from "effect";

import { Shell } from "../command.ts";
import { Git, GitError, mainRef } from "../git.ts";
import type { BranchCommit, SyncOutcome } from "../git.ts";
import { Host } from "../settings.ts";

const branch = "flake-update";

const remoteBranch = `origin/${branch}`;

const fixerAuthor = {
  GIT_AUTHOR_NAME: "flake-fixer",
  GIT_AUTHOR_EMAIL: "mippbipp+flake-fixer@users.noreply.github.com",
};

const lines = (text: string) =>
  Arr.filter(Str.split(Str.trim(text), "\n"), Str.isNonEmpty);

const fail = (message: string) => (cause: unknown) =>
  GitError.make({ message, cause });

// Hooks never run: the Updater's checkout does exactly what this file says
// and nothing a commit could smuggle in.
const withoutHooks = (rest: readonly string[]) => [
  "-c",
  "core.hooksPath=/dev/null",
  ...rest,
];

const describe = (rest: readonly string[]) => `git ${Arr.join(rest, " ")}`;

export const layer = Layer.effect(
  Git,
  Effect.gen(function* () {
    const host = yield* Host;
    const { exec, run } = yield* Shell;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitDir = path.join(host.repoDir, ".git");

    // gh's credential helper lives in the checkout's own config file, so the
    // user's Home Manager git config stays untouched.
    const env = {
      GIT_CONFIG_GLOBAL: path.join(host.repoDir, ".gitconfig"),
      GH_TOKEN: Redacted.value(host.token),
      GIT_TERMINAL_PROMPT: "0",
    };

    const git = (
      rest: readonly string[],
      extra: Readonly<Record<string, string>> = {}
    ) => {
      const options = { cwd: host.repoDir, env: { ...env, ...extra } };
      const toError = fail(describe(rest));

      return run("git", withoutHooks(rest), options).pipe(
        Effect.mapError(toError)
      );
    };

    const gitStatus = (rest: readonly string[]) => {
      const options = { cwd: host.repoDir, env };
      const toError = fail(describe(rest));

      return exec("git", withoutHooks(rest), options).pipe(
        Effect.map((output) => output.exitCode),
        Effect.mapError(toError)
      );
    };

    const prepare = Effect.gen(function* () {
      const cloned = yield* fs
        .exists(gitDir)
        .pipe(Effect.mapError(fail("checking the checkout")));

      if (!cloned) {
        yield* fs
          .makeDirectory(host.repoDir, { recursive: true })
          .pipe(Effect.mapError(fail("creating the checkout directory")));
        yield* run("git", [
          "clone",
          `https://github.com/${host.repo}.git`,
          host.repoDir,
        ]).pipe(Effect.mapError(fail("cloning the repository")));
      }

      yield* run("gh", ["auth", "setup-git", "--hostname", "github.com"], {
        env,
      }).pipe(Effect.mapError(fail("configuring gh as git credential helper")));
      yield* git(["config", "user.name", "mippbipp"]);
      yield* git(["config", "user.email", "mippbipp@users.noreply.github.com"]);
      // A run that died mid-merge would otherwise wedge every later run.
      yield* gitStatus(["merge", "--abort"]);
      yield* gitStatus(["rebase", "--abort"]);
      // The submodule URL uses SSH syntax, while this service authenticates
      // over HTTPS with the token.
      yield* git([
        "-c",
        "fetch.recurseSubmodules=false",
        "fetch",
        "--prune",
        "origin",
      ]);
    });

    // --force: a run killed before commitLock leaves flake.lock modified.
    const startFromMain = Effect.gen(function* () {
      yield* git(["checkout", "--force", "-B", branch, mainRef]);
      yield* git(["reset", "--hard", mainRef]);
    });

    const sync = Effect.fn("Git.sync")(function* (continuing: boolean) {
      const remoteExists =
        (yield* gitStatus([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remoteBranch}`,
        ])) === 0;

      if (!continuing || !remoteExists) {
        yield* startFromMain;

        return { mode: "fresh", dropped: [] } satisfies SyncOutcome;
      }

      yield* git(["checkout", "--force", "-B", branch, remoteBranch]);
      yield* git(["reset", "--hard", remoteBranch]);

      const merged = yield* gitStatus([
        "merge",
        "--no-edit",
        "-m",
        "merge main",
        mainRef,
      ]);

      if (merged === 0) {
        return { mode: "continued", dropped: [] } satisfies SyncOutcome;
      }

      const conflicts = lines(
        yield* git(["diff", "--name-only", "--diff-filter=U"])
      );

      // flake.lock is regenerated right after this anyway.
      if (Arr.join(conflicts, "\n") === "flake.lock") {
        yield* git(["checkout", mainRef, "--", "flake.lock"]);
        yield* git(["add", "flake.lock"]);
        yield* git(["commit", "--no-edit"]);

        return { mode: "continued", dropped: [] } satisfies SyncOutcome;
      }

      const dropped = lines(
        yield* git([
          "rev-list",
          "--no-merges",
          "--abbrev-commit",
          `${mainRef}..${remoteBranch}`,
        ])
      );

      yield* git(["merge", "--abort"]);
      yield* startFromMain;

      return { mode: "reset", dropped } satisfies SyncOutcome;
    });

    const commitLock = Effect.fn("Git.commitLock")(function* (message: string) {
      if ((yield* gitStatus(["diff", "--quiet", "--", "flake.lock"])) === 0) {
        return false;
      }

      yield* git(["add", "flake.lock"]);
      yield* git(["commit", "-m", message]);

      return true;
    });

    const branchCommits = git([
      "log",
      "--no-merges",
      "--format=%H%x1f%B%x1e",
      `${mainRef}..HEAD`,
    ]).pipe(
      Effect.map((output) =>
        Arr.flatMap(Str.split(output, "\u001E"), (record): BranchCommit[] => {
          const [sha, message] = Str.split(Str.trim(record), "\u001F");

          return sha === undefined || sha === "" || message === undefined
            ? []
            : [{ sha, message: Str.trim(message) }];
        })
      )
    );

    const push = Effect.fn("Git.push")(function* (replace: boolean) {
      const refspec = `HEAD:${branch}`;

      const pushArgs = replace
        ? ["push", "--force-with-lease", "origin", refspec]
        : ["push", "origin", refspec];

      if (host.dryRun) {
        yield* Effect.log(`dry-run: would run git ${Arr.join(pushArgs, " ")}`);

        return;
      }

      yield* git(pushArgs);
    });

    const clearDirectory = Effect.fn("Git.clearDirectory")(function* (
      dir: string
    ) {
      yield* fs.makeDirectory(dir, { recursive: true });

      for (const entry of yield* fs.readDirectory(dir)) {
        yield* fs.remove(path.join(dir, entry), { recursive: true });
      }
    });

    const archive = path.join(gitDir, "flake-fixer.tar");

    // Submodules are never checked out; their empty directories keep git
    // from reading the gitlinks as deleted when the workspace is imported.
    const gitlinks = git(["ls-tree", "-r", "HEAD"]).pipe(
      Effect.map((listing) =>
        Arr.flatMap(lines(listing), (entry) => {
          const match = /^160000 commit \S+\t(?<file>.+)$/u.exec(entry);

          return match?.groups?.file === undefined ? [] : [match.groups.file];
        })
      )
    );

    const exportTree = Effect.fn("Git.exportTree")(function* (dir: string) {
      yield* clearDirectory(dir).pipe(Effect.mapError(fail(`clearing ${dir}`)));
      yield* git(["archive", "--format=tar", "-o", archive, "HEAD"]);
      yield* run("tar", ["-xf", archive, "-C", dir]).pipe(
        Effect.mapError(fail(`unpacking HEAD into ${dir}`))
      );

      for (const link of yield* gitlinks) {
        yield* fs
          .makeDirectory(path.join(dir, link), { recursive: true })
          .pipe(Effect.mapError(fail(`creating ${link} in ${dir}`)));
      }

      // tar drops the workspace's setgid group on the directories it creates;
      // hand every entry to the workspace's group so the Flake fixer can edit.
      const listed = yield* fs
        .readDirectory(dir)
        .pipe(Effect.mapError(fail(`listing ${dir}`)));

      const entries = Arr.map(listed, (entry) => path.join(dir, entry));
      const share = fail(`sharing ${dir} with the Flake fixer`);

      yield* run("chgrp", ["-R", `--reference=${dir}`, ...entries]).pipe(
        Effect.mapError(share)
      );
      yield* run("chmod", ["-R", "g+rwX", ...entries]).pipe(
        Effect.mapError(share)
      );
    });

    // A separate index keeps the Updater's own index and work tree out of it.
    // The explicit --git-dir means git reads only file contents from the
    // workspace, never a config or hooks directory planted there.
    const index = { GIT_INDEX_FILE: path.join(gitDir, "flake-fixer-index") };

    const importTree = Effect.fn("Git.importTree")(function* (
      dir: string,
      lock: string
    ) {
      yield* fs
        .writeFileString(path.join(dir, "flake.lock"), lock)
        .pipe(Effect.mapError(fail("writing flake.lock into the workspace")));
      yield* git(["read-tree", "HEAD"], index);
      yield* run(
        "git",
        withoutHooks(["--git-dir", gitDir, "--work-tree", dir, "add", "--all"]),
        { cwd: dir, env: { ...env, ...index } }
      ).pipe(Effect.mapError(fail(`staging ${dir}`)));

      const tree = Str.trim(yield* git(["write-tree"], index));

      // `:<old mode> <new mode> <old sha> <new sha> <status>\t<path>`
      const raw = lines(yield* git(["diff-tree", "-r", "--raw", "HEAD", tree]));
      const files = Arr.map(raw, (line) => Str.split(line, "\t")[1] ?? "");

      const changedGitlinks = Arr.flatMap(raw, (line) =>
        Str.split(line, " ")[1] === "160000"
          ? [Str.split(line, "\t")[1] ?? ""]
          : []
      );

      return { tree, files, gitlinks: changedGitlinks };
    });

    const commitTree = Effect.fn("Git.commitTree")(function* (
      tree: string,
      message: string
    ) {
      const sha = Str.trim(
        yield* git(
          ["commit-tree", tree, "-p", "HEAD", "-m", message],
          fixerAuthor
        )
      );

      yield* git(["reset", "--hard", sha]);

      return sha;
    });

    return Git.of({
      prepare,
      sync,
      commitLock,
      readLock: (rev) => git(["show", `${rev}:flake.lock`]),
      head: git(["rev-parse", "HEAD"]).pipe(Effect.map(Str.trim)),
      branchCommits,
      changedFromMain: git(["diff", "--name-only", mainRef, "HEAD"]).pipe(
        Effect.map(lines)
      ),
      push,
      exportTree,
      importTree,
      commitTree,
    });
  })
);
