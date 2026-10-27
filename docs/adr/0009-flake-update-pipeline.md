# Flake updates verified by a build gate before merge

The old `update-flake-lock` workflow opened a PR and enabled auto-merge unconditionally, so an eval-broken lock bump could land on main overnight. We replace it with a split pipeline whose invariant is: **main is always buildable for every NixOS host** (every `nixosConfigurations.<host>` entry). The decision record and the operational runbook share this one document.

- **Updater** (systemd timer on pewter, Mondays ~02:00): runs `nix flake update` on the stable `flake-update` branch and creates-or-updates the single accumulating PR. When that PR is still open from an earlier week it merges main into the branch and keeps going, so code fixes waiting on review survive the next run. Otherwise it starts the branch over from main.
- **Build gate** (GitHub Actions, free runners): one job per arch builds every host of that arch (0018 explains the shift from one job per host). These checks are required for merge and use the public fleet Attic cache for substitution.
- **Flake fixer** (opt-in, opencode agent on pewter): when the gate is red, the Updater hands the trimmed failure to an agent that either fixes our configuration or asks for an input to be held back at main's revision. The Updater commits the result and waits for the gate again, for at most three rounds.
- **Merge**: GitHub auto-merge fires only once the gate is green. A PR carrying a Flake fixer code change loses auto-merge and waits for a person; a PR that only holds inputs back keeps it.
- **Watchdog** (monthly Actions job, 1st at 09:00 UTC): fails, and therefore emails, if the last committed lock update is older than ~30 days, covering silent Updater death (expired credentials, dead timer) where no other channel fires.

Why this shape: verification needs native x86_64 *and* aarch64 compute; GitHub provides both free for public repos, while pewter is always-on and already git-authenticated, making it the natural orchestrator and deploy target. Testing happens entirely pre-merge on runners; pewter's own rebuild happens post-merge because activation can only be exercised by deploying.

Why an agent instead of reverting whichever input broke: most red weeks are our configuration's fault, not an input's. PR #232 failed because nixpkgs removed `boot.initrd.systemd.enable` and `boot.initrd.verbose`; reverting nixpkgs would have turned the gate green while hiding a two-line fix and holding back every input that follows nixpkgs. Telling the two cases apart needs the gate log, the lock diff and the upstream source, which is judgment, not parsing.

Host names are intentionally not enumerated in this document; `docs/agents/adding-a-host.md` covers adding a host.

## Operational runbook

### Pipeline

The sequence is:

1. `flake-updater.timer` runs Mondays around 02:00 on pewter with persistence and a 30-minute randomized delay.
2. `flake-updater.service` runs as the configured pewter user, updates a clone in `/var/lib/flake-updater`, and maintains one `flake-update` branch and pull request. It is a TypeScript/Effect program in `hosts/pewter/flake-updater/`; the package's check phase runs its typecheck, tests, formatter and linter, so the `build aarch64-linux` gate job tests every change to it.
3. GitHub Actions runs `.github/workflows/build-gate.yml` for every pull request. It builds every host's toplevel closure, one `build <system>` check per arch. Each arch job enumerates the flake's hosts for its system and builds them all in a single `/nix/store`, so derivations shared by same-arch hosts compile once; per-host failures are grouped as `build <host>` sections in that arch's job log.
4. GitHub auto-merge is enabled by the Updater, but merge waits for all required `build <system>` checks to pass.
5. With the Flake fixer enabled, the Updater waits for the gate on its own push and runs repair rounds while it is red.
6. `.github/workflows/watchdog.yml` runs on the 1st of each month at 09:00 UTC and fails when the latest `flake.lock` commit is more than thirty days old.

### Updater

The Updater reads the GitHub token from the SOPS secret `github_token`. It keeps GitHub's credential helper in the updater checkout's `.gitconfig`, rather than changing the user's Home Manager-managed global Git configuration. It also sets the commit identity explicitly and runs git with hooks disabled.

Each run:

1. Fetches origin without recursing into submodules. The repository's submodule URL uses GitHub SSH syntax while the service authenticates through HTTPS and the token.
2. Rebuilds the local `flake-update` branch. With an open PR it checks out `origin/flake-update` and merges `origin/main` into it. A conflict in `flake.lock` alone takes main's copy, since step 3 regenerates it. Any other conflict aborts the merge, logs the dropped commit SHAs, and starts over from main. Without an open PR the branch starts over from main.
3. Runs `nix flake update` and commits `flake.lock` if it changed. Inputs held back last week are updated again here, so they are retried every week.
4. Exits successfully when the branch no longer differs from main.
5. Pushes. A continued branch is a fast-forward; a branch that started over is pushed with `--force-with-lease`, because a merged PR's branch can linger on the remote.
6. Creates the PR if absent and regenerates its body from the branch: updated inputs as `name old → new`, held-back inputs with their issues, and Flake fixer commits. Squash auto-merge is requested unless a Flake fixer commit on the branch needs review (one commit per update on `main`, even when the branch carries fix-ups next to the lock bump).

Manual operation:

```sh
ssh pewter 'systemctl status flake-updater.timer'
ssh pewter 'flake-updater --dry-run --repo-dir /tmp/flake-updater-dry'
ssh pewter 'sudo systemctl start flake-updater.service'
ssh pewter 'sudo journalctl -u flake-updater.service -n 100 --no-pager'
```

Use `--dry-run` before investigating an unexpected update. It updates a checkout, prints the PR body it would write, and reads GitHub without pushing, commenting, or opening anything. Point it at a scratch `--repo-dir` so it does not disturb the service's checkout. With `--agent` added, the dry run evaluates every host and `nix flake check --no-build` locally in place of the Build gate, and runs Flake fixer rounds against that result. It needs the fixer's server running and catches evaluation failures, not build failures.

### Flake fixer

The Flake fixer is the `flake-fixer` opencode agent on a dedicated server, enabled with `services.flake-updater.agent.enable` in pewter's config. Its model is `services.flake-updater.agent.model`, `opencode/deepseek-v4.1-flash-free` by default.

When the gate is red, each round:

1. Checks that every failed check is a `build <system>` or `checks <system>` job. Anything else, such as `flake-update-scope`, stops the repair.
2. Trims each failed job's `gh run view --log-failed` output to its Nix error blocks, grouped by job and the `build <host>` section they came from.
3. Copies the branch's tree into `/var/lib/flake-fixer/work` and writes main's `flake.lock` to `/var/lib/flake-fixer/context`.
4. Prompts the agent (round 1 opens a session titled `flake-update #<pr>`; later rounds continue it). The agent fixes configuration that uses renamed or removed upstream options, or lists inputs to hold back. It must evaluate every host's `toplevel.drvPath` and run `nix flake check --no-build` before it finishes; building is left to the gate.
5. Asks the agent for a JSON report: outcome, held-back inputs, changed files, summary.
6. Rebuilds `flake.lock` itself from the report: every held-back input is reset to main's node and everything else stays as the update left it. The agent's own lock edits are ignored.
7. Discards the round, and tells the agent why next round, when it changed nothing, touched a blocked path (`.github/`, `secrets/`, `.sops.yaml`, `checks.nix`, `hosts/pewter/flake-updater/`), or reported files that differ from what it changed.
8. Otherwise commits the result on top of the branch as author `flake-fixer`, with `Flake-Fixer-*` trailers recording the round, session, held-back inputs and whether review is needed, then pushes.
9. Opens or comments on one `flake-update: <input> held back` issue per held-back input, with the failing hosts, the trimmed error, the failing checks and the session.

A commit that changes anything besides `flake.lock`, or a lock that is not exactly a reset to main's revisions, needs review: the Updater turns auto-merge off and labels the PR `ready-for-human`. Merge it by hand after reading the commit.

The repair stops and opens or comments on `flake-update: repair failed` when the gate is still red after three rounds, the agent gives up, the server or model is unavailable, a check outside the gate fails, or 11.5 hours pass (the unit's hard limit is 12). A green gate closes that issue. A held-back issue closes itself once main has a newer revision of its input.

The agent never touches the Updater's checkout or its credentials:

- It runs as the `flake-fixer` system user in its own `opencode2 serve` on `127.0.0.1:4097`, with `ProtectSystem=strict`, `ProtectHome`, and `/run/secrets`, `/var/lib/flake-updater` and `/var/lib/sops-nix` inaccessible. Nothing secret is reachable from its shell; the repository is public.
- The Updater reads the workspace back through its own `.git` with a separate index file. Git never runs inside a directory the agent can write, so a planted hook or config has nothing to run.
- Its opencode config comes from `hosts/pewter/flake-updater/opencode-config.nix` through a read-only `XDG_CONFIG_HOME`, and project config is disabled. Policies there hard-deny web access, subagents, git, network tools, `nix build`/`run`/`shell`, `--impure`, edits to blocked paths, reads under `secrets/`, and every provider except the model's.
- Each session carries the Updater's allowlist of shell commands and paths. Anything outside it asks, and the Updater rejects every ask.
- The `flake-update-scope` workflow runs main's copy on `pull_request_target` and fails a `flake-update` PR whose diff touches a blocked path.

The server password is generated once into `/var/lib/flake-updater/fixer-password` and handed to the server as a systemd credential. It guards the web UI, not the agent: the agent runs inside that server and could read it.

Read a session from any tailnet device at `https://pewter.<tailnet>:8444` with user `opencode` and that password:

```sh
ssh pewter 'systemctl status flake-fixer.service'
ssh pewter 'sudo cat /var/lib/flake-updater/fixer-password'
ssh pewter 'sudo journalctl -u flake-fixer.service -n 100 --no-pager'
```

To try the agent on the current state without pushing, run the dry run with `--agent` (see Updater).

`hosts/pewter/flake-updater/` has its own `package.json`, pinned through `pnpm-lock.yaml` and the `pnpmDeps` hash in `package.nix`. A dependency change needs a new hash; the Updater never edits either, so npm dependencies only move in your own PRs.

### Build gate

The Build gate builds each system's full toplevel closure:

```sh
nix build ".#nixosConfigurations.<host>.config.system.build.toplevel"
```

The matrix in `.github/workflows/build-gate.yml` has one job per arch with a runner matching the platform. Each job enumerates the flake's hosts for its system (`nixosConfigurations` filtered by `config.nixpkgs.hostPlatform.system`) and builds them sequentially with per-host `--out-link result-<host>` files, keeping a failure accumulator so one broken host does not mask another. The workflow evaluates the checkout as a plain flake source. Repo-relative Home Manager paths resolve out-of-store from the host's `~/conf.nix` checkout, so no submodule content is read and no special ref form is needed. The workflow uses the public fleet Attic cache for substitution. Successful same-repository PR builds push every per-host closure to that cache; Attic dedups paths shared across hosts server-side.

When a check fails, open the arch job log and find the grouped `build <host>` section for the failing host before changing the pipeline. A PR must have every `build <system>` check successful before it is eligible for auto-merge.

### Watchdog

The Watchdog checks the newest commit touching `flake.lock`. It runs on the 1st of each month and can also be dispatched manually:

```sh
gh workflow run update-watchdog
gh run list --workflow update-watchdog --limit 1
gh run watch <run-id> --exit-status
```

The required evidence is a completed run with conclusion `success` and a recent-lock message. A failure means the Updater may be stale even if the systemd timer still exists.

### Recovery and evidence

For a failed update, collect evidence in this order:

1. `gh pr view <number>` and `gh pr checks <number>`.
2. Open issues labelled `automated`: `flake-update: repair failed` and any `flake-update: <input> held back`.
3. The failed Build gate job log, if applicable.
4. The Flake fixer session named in the PR body or issue, in the fixer's web UI.
5. `systemctl status` and `journalctl` for `flake-updater.service` and, with the Flake fixer enabled, `flake-fixer.service` on pewter.
6. Watchdog status and the last `flake.lock` commit age.

Do not bypass the Build gate to land an unverified revision. If a service change is needed, send it through a pull request and wait for every `build <system>` check. A fix you push to `flake-update` by hand survives the next run as long as the PR stays open.

### Host changes

When adding a host, update the GitHub ruleset's required checks only when the host introduces a new arch, in addition to the NixOS host declarations. Follow `docs/agents/adding-a-host.md`; all of these are part of the verification invariant:

- A host of an already-covered arch needs no Build gate edit: the arch job enumerates it from the flake automatically. A new arch needs one `- system:` row in the `build-closure` matrix, plus `build <system>` in the ruleset's required checks.
- One `hosts.<host>` record in `modules/fleet/registry.nix`.
- The `checks (x86_64-linux)` and `checks (aarch64-linux)` jobs need no per-host edits. The step enumerates every check via `nix eval ... --apply builtins.attrNames`. Both must stay required in the ruleset or the registry and profile checks stop gating.

The `build-matrix-sync` check fails the gate when the matrix rows and the `nixosConfigurations` keys drift in either direction.

## Considered options

- **Pure pewter pipeline** (no Actions at all): elegant, but x86_64 hosts could only be eval-checked under emulation or not at all, which downgrades the invariant from "buildable" to "evaluable". Rejected.
- **Self-hosted garnix-ci** (open-sourced after their shutdown): gives orchestration, not builders. We'd still need x86_64 compute behind it, plus a Haskell backend, database, and registered GitHub App for one personal repo. Disproportionate. Rejected.
- **Actions-only** (the status quo ante): no persistent orchestrator, and pre-pipeline it merged unverified. The updater role belongs somewhere always-on. Superseded.
- **Revert the failing input automatically**, finding it by parsing `«github:owner/repo/rev»` frames out of the gate log: cheap, but the trace for #232 points at our own `common.nix`, and compile failures deep inside nixpkgs name no input at all. Rejected.
- **Bisect inputs through CI**, reverting half the changed inputs per push: accurate, but each step is a full gate run, about five rounds for twenty inputs, and every input follows nixpkgs, so reverting nixpkgs evaluates the rest against the old one anyway. Rejected.
- **Run the agent in the user's existing opencode server**: no new service, but that server runs as the user who holds the GitHub token, the SSH mesh keys and pewter's LUKS unlock key, while the agent reads untrusted logs and upstream code. Rejected for a separate user and sandbox.
- **Let the agent commit and push**: fewer moving parts, but it puts push credentials and a writable `.git` in reach of the agent. Rejected; the Updater commits and pushes.

## Consequences

- Branch protection requiring the gate checks also blocks direct pushes to main; deliberate local work goes through PRs (or admin bypass stays enabled knowingly).
- Bootstrap circularity: the Updater config lives in the repo it pushes to; first install is a manual `nrs pewter`.
- WSL hosts are built but never booted by CI, so runtime breakage there still surfaces on next interactive use.
- A Flake fixer code change merges only after a person reads it. A week whose fix waits on review keeps accumulating updates on the same PR.
- The default model is free and rate-limited per day. When its quota is spent the run opens `flake-update: repair failed` naming the model and never switches to a paid one; switching is a config change.
- `flake-update-scope` must be added to the ruleset's required checks by hand, after its first run shows it on a PR.

Status: accepted, partially superseded by 0018 (gate architecture only: one job per host became one job per arch). Extended with the Flake fixer and the continue-the-open-PR Updater.
