import { NodeServices } from "@effect/platform-node";
import { assert, layer, describe } from "@effect/vitest";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Layer,
  Path,
  Record as Rec,
  Redacted,
  String as Str,
} from "effect";

import { Shell } from "../src/command.ts";
import { Git, GitError, mainRef } from "../src/git.ts";
import * as GitLive from "../src/live/git.ts";
import { Host } from "../src/settings.ts";

/** The real Shell, except `gh`: these tests never reach GitHub. */
const offlineShell = Layer.effect(
  Shell,
  Effect.gen(function* () {
    const shell = yield* Shell;
    const skipped = { stdout: "", stderr: "", exitCode: 0 };

    return Shell.of({
      exec: (command, args, options) =>
        command === "gh"
          ? Effect.succeed(skipped)
          : shell.exec(command, args, options),
      run: (command, args, options) =>
        command === "gh"
          ? Effect.succeed("")
          : shell.run(command, args, options),
    });
  })
).pipe(Layer.provide(Shell.layer));

const services = offlineShell.pipe(Layer.provideMerge(NodeServices.layer));

type Where = "origin" | "upstream" | "checkout" | "workspace";

const gitlink = "modules/sub";

const gitlinkSha = Str.repeat(40)("1");

const initialFiles = {
  "flake.lock": "main lock\n",
  "README.md": "readme\n",
  "old.nix": "old\n",
};

/**
 * A bare `origin` with main pushed from an `upstream` clone, and the
 * Updater's checkout cloned from it, so fetch and push stay local.
 */
const makeRemote = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = yield* Shell;

  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "flake-updater-git-",
  });

  const dirs: Record<Where, string> = {
    origin: path.join(root, "origin.git"),
    upstream: path.join(root, "upstream"),
    checkout: path.join(root, "checkout"),
    workspace: path.join(root, "workspace"),
  };

  const env = {
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "upstream",
    GIT_AUTHOR_EMAIL: "upstream@example.test",
    GIT_COMMITTER_NAME: "upstream",
    GIT_COMMITTER_EMAIL: "upstream@example.test",
  };

  const git = (where: Where, args: readonly string[]) =>
    shell
      .run("git", args, { cwd: dirs[where], env })
      .pipe(Effect.map(Str.trim));

  const succeeds = (where: Where, args: readonly string[]) =>
    shell
      .exec("git", args, { cwd: dirs[where], env })
      .pipe(Effect.map((output) => output.exitCode === 0));

  const write = (where: Where, files: Readonly<Record<string, string>>) =>
    Effect.forEach(Rec.toEntries(files), ([file, content]) => {
      const target = path.join(dirs[where], file);

      return fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(target, content)));
    });

  /** Commits `files` on `branch` in upstream and pushes it to origin. */
  const publish = Effect.fn("publish")(function* (
    branch: string,
    files: Readonly<Record<string, string>>,
    message: string
  ) {
    const exists = yield* succeeds("upstream", [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);

    yield* git(
      "upstream",
      exists ? ["switch", "-q", branch] : ["switch", "-q", "-c", branch, "main"]
    );
    yield* write("upstream", files);
    yield* git("upstream", ["add", "--", ...Rec.keys(files)]);
    yield* git("upstream", ["commit", "-q", "-m", message]);
    yield* git("upstream", ["push", "-q", "--force", "origin", branch]);

    return yield* git("upstream", ["rev-parse", "HEAD"]);
  });

  /** The Updater's Git, prepared the way a run starts. */
  const connect = (dryRun: boolean) => {
    const host = Layer.succeed(Host)({
      repoDir: dirs.checkout,
      repo: "mippbipp/conf.nix",
      token: Redacted.make("x"),
      dryRun,
    });

    const gitLayer = GitLive.layer.pipe(Layer.provide(host));

    return Effect.gen(function* () {
      const live = yield* Git;

      yield* live.prepare;

      return live;
    }).pipe(Effect.provide(gitLayer));
  };

  const exists = (where: Where, file: string) =>
    fs.exists(path.join(dirs[where], file));

  yield* fs.makeDirectory(dirs.upstream);
  yield* git("upstream", ["init", "-q", "--bare", "-b", "main", dirs.origin]);
  yield* git("upstream", ["init", "-q", "-b", "main"]);
  yield* git("upstream", ["remote", "add", "origin", `file://${dirs.origin}`]);
  yield* write("upstream", initialFiles);
  yield* git("upstream", ["add", "--all"]);
  yield* git("upstream", [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkSha},${gitlink}`,
  ]);
  yield* git("upstream", ["commit", "-q", "-m", "init"]);
  yield* git("upstream", ["push", "-q", "origin", "main"]);
  yield* git("upstream", [
    "clone",
    "-q",
    `file://${dirs.origin}`,
    dirs.checkout,
  ]);

  return {
    dirs,
    git,
    succeeds,
    write,
    publish,
    connect,
    exists,
    remove: (where: Where, file: string) =>
      fs.remove(path.join(dirs[where], file), { recursive: true }),
    read: (where: Where, file: string) =>
      fs.readFileString(path.join(dirs[where], file)),
    list: (where: Where) => fs.readDirectory(dirs[where], { recursive: true }),
  };
});

/** A checkout that started over from main and committed a new lock. */
const replaced = (dryRun: boolean) =>
  Effect.gen(function* () {
    const remote = yield* makeRemote;

    const remoteSha = yield* remote.publish(
      "flake-update",
      { "flake.lock": "old pr lock\n" },
      "up"
    );

    const git = yield* remote.connect(dryRun);
    yield* git.sync(false);
    yield* remote.write("checkout", { "flake.lock": "updated lock\n" });
    yield* git.commitLock("up");

    return { remote, git, remoteSha };
  });

const originBranch = (remote: Effect.Success<typeof makeRemote>) =>
  remote.git("origin", ["rev-parse", "flake-update"]);

layer(services, { excludeTestServices: true })("live git", (it) => {
  describe("sync", () => {
    it.effect("starts from main when there is no PR", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        yield* remote.publish("flake-update", { "stale.nix": "x\n" }, "stale");
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(false);

        assert.deepStrictEqual(outcome, { mode: "fresh", dropped: [] });
        assert.strictEqual(
          yield* git.head,
          yield* remote.git("checkout", ["rev-parse", mainRef])
        );
        assert.strictEqual(
          yield* remote.git("checkout", ["branch", "--show-current"]),
          "flake-update"
        );
      })
    );

    it.effect("starts from main when the PR branch is gone from origin", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(true);

        assert.deepStrictEqual(outcome, { mode: "fresh", dropped: [] });
        assert.strictEqual(
          yield* git.head,
          yield* remote.git("checkout", ["rev-parse", mainRef])
        );
      })
    );

    it.effect("merges main into the PR branch", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;

        const branch = yield* remote.publish(
          "flake-update",
          { "fix.nix": "fix\n" },
          "fix"
        );

        const main = yield* remote.publish(
          "main",
          { "main.nix": "main\n" },
          "main moved"
        );

        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(true);

        assert.deepStrictEqual(outcome, { mode: "continued", dropped: [] });
        assert.strictEqual(
          yield* remote.git("checkout", ["rev-parse", "HEAD^1", "HEAD^2"]),
          `${branch}\n${main}`
        );
        assert.deepStrictEqual(yield* git.changedFromMain, ["fix.nix"]);
      })
    );

    it.effect("takes main's flake.lock when only flake.lock conflicts", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        yield* remote.publish(
          "flake-update",
          { "flake.lock": "branch lock\n", "fix.nix": "fix\n" },
          "up"
        );
        yield* remote.publish("main", { "flake.lock": "newer lock\n" }, "bump");
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(true);

        assert.deepStrictEqual(outcome, { mode: "continued", dropped: [] });
        assert.strictEqual(yield* git.readLock("HEAD"), "newer lock\n");
        assert.deepStrictEqual(yield* git.changedFromMain, ["fix.nix"]);
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
        assert.isFalse(
          yield* remote.succeeds("checkout", [
            "rev-parse",
            "--verify",
            "--quiet",
            "MERGE_HEAD",
          ])
        );
      })
    );

    it.effect("drops the PR's commits when main conflicts with its code", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;

        const lock = yield* remote.publish(
          "flake-update",
          { "flake.lock": "branch lock\n" },
          "up"
        );

        const code = yield* remote.publish(
          "flake-update",
          { "README.md": "branch readme\n" },
          "fix"
        );

        yield* remote.publish("main", { "README.md": "main readme\n" }, "edit");
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(true);

        assert.strictEqual(outcome.mode, "reset");
        assert.lengthOf(outcome.dropped, 2);
        assert.deepStrictEqual(
          Arr.zipWith([code, lock], outcome.dropped, (sha, short) =>
            Str.startsWith(short)(sha)
          ),
          [true, true]
        );
        assert.strictEqual(
          yield* git.head,
          yield* remote.git("checkout", ["rev-parse", mainRef])
        );
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
      })
    );

    it.effect("discards a flake.lock a killed run left uncommitted", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        yield* (yield* remote.connect(false)).sync(false);
        yield* remote.write("checkout", { "flake.lock": "half done\n" });
        yield* remote.publish("main", { "flake.lock": "newer lock\n" }, "bump");
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(false);

        assert.strictEqual(outcome.mode, "fresh");
        assert.strictEqual(yield* git.readLock("HEAD"), "newer lock\n");
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
      })
    );

    it.effect("discards that flake.lock when continuing the PR too", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        yield* (yield* remote.connect(false)).sync(false);
        yield* remote.write("checkout", { "flake.lock": "half done\n" });
        yield* remote.publish(
          "flake-update",
          { "flake.lock": "pr lock\n" },
          "up"
        );
        const git = yield* remote.connect(false);

        const outcome = yield* git.sync(true);

        assert.strictEqual(outcome.mode, "continued");
        assert.strictEqual(yield* git.readLock("HEAD"), "pr lock\n");
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
      })
    );
  });

  describe("commitLock", () => {
    it.effect("commits nothing when flake.lock is unchanged", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        const before = yield* git.head;

        assert.isFalse(yield* git.commitLock("up"));
        assert.strictEqual(yield* git.head, before);
      })
    );

    it.effect("commits a changed flake.lock", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        const before = yield* git.head;
        yield* remote.write("checkout", { "flake.lock": "updated lock\n" });

        assert.isTrue(yield* git.commitLock("up"));
        assert.strictEqual(
          yield* remote.git("checkout", ["log", "-1", "--format=%P %s"]),
          `${before} up`
        );
        assert.deepStrictEqual(yield* git.changedFromMain, ["flake.lock"]);
      })
    );
  });

  describe("push", () => {
    it.effect("fast-forwards the PR branch", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        yield* remote.publish("flake-update", { "fix.nix": "fix\n" }, "fix");
        const git = yield* remote.connect(false);
        yield* git.sync(true);
        yield* remote.write("checkout", { "flake.lock": "updated lock\n" });
        yield* git.commitLock("up");

        yield* git.push(false);

        assert.strictEqual(yield* originBranch(remote), yield* git.head);
      })
    );

    it.effect("refuses a push that is not a fast-forward", () =>
      Effect.gen(function* () {
        const { remote, git, remoteSha } = yield* replaced(false);

        const error = yield* Effect.flip(git.push(false));

        assert.instanceOf(error, GitError);
        assert.strictEqual(yield* originBranch(remote), remoteSha);
      })
    );

    it.effect(
      "replaces the branch when origin is where the fetch left it",
      () =>
        Effect.gen(function* () {
          const { remote, git } = yield* replaced(false);

          yield* git.push(true);

          assert.strictEqual(yield* originBranch(remote), yield* git.head);
        })
    );

    it.effect("will not replace a branch that moved since the fetch", () =>
      Effect.gen(function* () {
        const { remote, git } = yield* replaced(false);

        const moved = yield* remote.publish(
          "flake-update",
          { "late.nix": "late\n" },
          "pushed during the run"
        );

        const error = yield* Effect.flip(git.push(true));

        assert.instanceOf(error, GitError);
        assert.strictEqual(yield* originBranch(remote), moved);
      })
    );

    it.effect("pushes nothing in a dry run", () =>
      Effect.gen(function* () {
        const { remote, git, remoteSha } = yield* replaced(true);

        yield* git.push(true);
        yield* git.push(false);

        assert.strictEqual(yield* originBranch(remote), remoteSha);
      })
    );
  });

  describe("workspace", () => {
    it.effect("exports HEAD as plain files over a stale workspace", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        yield* remote.write("workspace", { "stale/file.nix": "stale\n" });

        yield* git.exportTree(remote.dirs.workspace);

        assert.deepStrictEqual(
          Arr.sort(yield* remote.list("workspace"), Str.Order),
          ["README.md", "flake.lock", "modules", gitlink, "old.nix"]
        );
        assert.strictEqual(
          yield* remote.read("workspace", "README.md"),
          "readme\n"
        );
      })
    );

    it.effect("lists changed, added and deleted files from the workspace", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        const before = yield* git.head;
        yield* git.exportTree(remote.dirs.workspace);
        yield* remote.write("workspace", {
          "README.md": "edited\n",
          "new/file.nix": "new\n",
        });
        yield* remote.remove("workspace", "old.nix");

        const imported = yield* git.importTree(
          remote.dirs.workspace,
          "fixed lock\n"
        );

        assert.deepStrictEqual(imported.files, [
          "README.md",
          "flake.lock",
          "new/file.nix",
          "old.nix",
        ]);
        assert.strictEqual(
          yield* remote.git("checkout", [
            "show",
            `${imported.tree}:flake.lock`,
          ]),
          "fixed lock"
        );
        assert.strictEqual(yield* git.head, before);
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
      })
    );

    it.effect("keeps gitlinks through an export and import", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        yield* git.exportTree(remote.dirs.workspace);

        const imported = yield* git.importTree(
          remote.dirs.workspace,
          initialFiles["flake.lock"]
        );

        assert.deepStrictEqual(imported.files, []);
        assert.deepStrictEqual(imported.gitlinks, []);
        assert.strictEqual(
          imported.tree,
          yield* remote.git("checkout", ["rev-parse", "HEAD^{tree}"])
        );
      })
    );

    it.effect("never reads git metadata planted in the workspace", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        yield* git.exportTree(remote.dirs.workspace);
        const marker = `${remote.dirs.upstream}/fsmonitor-ran`;
        const nested = ["-C", "vendor/evil"];
        yield* remote.git("workspace", ["init", "-q"]);
        yield* remote.git("workspace", [
          "config",
          "core.fsmonitor",
          `touch ${marker}`,
        ]);
        yield* remote.write("workspace", { "vendor/evil/a.nix": "a\n" });
        yield* remote.git("workspace", ["init", "-q", "vendor/evil"]);
        yield* remote.git("workspace", [...nested, "add", "a.nix"]);
        yield* remote.git("workspace", [...nested, "commit", "-q", "-m", "a"]);

        const nestedHead = yield* remote.git("workspace", [
          ...nested,
          "rev-parse",
          "HEAD",
        ]);

        yield* remote.git("workspace", [
          ...nested,
          "config",
          "core.fsmonitor",
          `touch ${marker}`,
        ]);

        const imported = yield* git.importTree(
          remote.dirs.workspace,
          initialFiles["flake.lock"]
        );

        // A nested repository becomes a gitlink, never its .git contents.
        assert.deepStrictEqual(imported.files, ["vendor/evil"]);
        assert.deepStrictEqual(imported.gitlinks, ["vendor/evil"]);
        assert.include(
          yield* remote.git("checkout", [
            "ls-tree",
            imported.tree,
            "vendor/evil",
          ]),
          `160000 commit ${nestedHead}`
        );
        assert.notMatch(
          yield* remote.git("checkout", [
            "ls-tree",
            "-r",
            "--name-only",
            imported.tree,
          ]),
          /(?:^|\/)\.git(?:\/|$)/mu
        );
        assert.isFalse(yield* remote.exists("upstream", "fsmonitor-ran"));
      })
    );

    it.effect("commits an imported tree as the Flake fixer", () =>
      Effect.gen(function* () {
        const remote = yield* makeRemote;
        const git = yield* remote.connect(false);
        yield* git.sync(false);
        const before = yield* git.head;
        yield* git.exportTree(remote.dirs.workspace);
        yield* remote.write("workspace", { "README.md": "edited\n" });

        const imported = yield* git.importTree(
          remote.dirs.workspace,
          initialFiles["flake.lock"]
        );

        const sha = yield* git.commitTree(imported.tree, "fix: readme\n\nWhy.");

        assert.strictEqual(yield* git.head, sha);
        assert.strictEqual(
          yield* remote.git("checkout", [
            "log",
            "-1",
            "--format=%P%n%T%n%an <%ae>%n%cn%n%B",
          ]),
          Arr.join(
            [
              before,
              imported.tree,
              "flake-fixer <mippbipp+flake-fixer@users.noreply.github.com>",
              "mippbipp",
              "fix: readme",
              "",
              "Why.",
            ],
            "\n"
          )
        );
        assert.strictEqual(
          yield* remote.read("checkout", "README.md"),
          "edited\n"
        );
        assert.strictEqual(
          yield* remote.git("checkout", ["status", "--porcelain"]),
          ""
        );
      })
    );
  });
});
