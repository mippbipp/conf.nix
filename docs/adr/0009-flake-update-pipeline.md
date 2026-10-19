# Flake updates verified by a build gate before merge

The old `update-flake-lock` workflow opened a PR and enabled auto-merge unconditionally, so an eval-broken lock bump could land on main overnight. We replace it with a split pipeline whose invariant is: **main is always buildable for every NixOS host** (every `nixosConfigurations.<host>` entry). The decision record and the operational runbook share this one document.

- **Updater** (systemd timer on pewter, Mondays ~02:00): resets its clone to origin/main, runs `nix flake update`, exits cleanly when the lock didn't change, otherwise force-pushes the stable `flake-update` branch and creates-or-updates the single accumulating PR.
- **Build gate** (GitHub Actions, free runners): one job per arch builds every host of that arch (0018 explains the shift from one job per host). These checks are required for merge and use the public fleet Attic cache for substitution.
- **Merge**: GitHub auto-merge fires only once the gate is green; failed weeks just leave the PR red until a later bump goes green.
- **Watchdog** (monthly Actions job, 1st at 09:00 UTC): fails, and therefore emails, if the last committed lock update is older than ~30 days, covering silent Updater death (expired credentials, dead timer) where no other channel fires.

Why this shape: verification needs native x86_64 *and* aarch64 compute; GitHub provides both free for public repos, while pewter is always-on and already git-authenticated, making it the natural orchestrator and deploy target. Testing happens entirely pre-merge on runners; pewter's own rebuild happens post-merge because activation can only be exercised by deploying.

Host names are intentionally not enumerated in this document; `docs/agents/adding-a-host.md` covers adding a host.

## Operational runbook

### Pipeline

The sequence is:

1. `flake-updater.timer` runs Mondays around 02:00 on pewter with persistence and a 30-minute randomized delay.
2. `flake-updater.service` runs as the configured pewter user, updates a clone in `/var/lib/flake-updater`, and maintains one `flake-update` branch and pull request.
3. GitHub Actions runs `.github/workflows/build-gate.yml` for every pull request. It builds every host's toplevel closure, one `build <system>` check per arch. Each arch job enumerates the flake's hosts for its system and builds them all in a single `/nix/store`, so derivations shared by same-arch hosts compile once; per-host failures are grouped as `build <host>` sections in that arch's job log.
4. GitHub auto-merge is enabled by the Updater, but merge waits for all required `build <system>` checks to pass.
5. `.github/workflows/watchdog.yml` runs on the 1st of each month at 09:00 UTC and fails when the latest `flake.lock` commit is more than thirty days old.

### Updater

The Updater reads the GitHub token from the SOPS secret `github_token`. It keeps GitHub's credential helper in the updater checkout's `.gitconfig`, rather than changing the user's Home Manager-managed global Git configuration. It also sets the commit identity explicitly.

Each run discards any previous `flake-update` state, resets the local branch to `origin/main`, and runs `nix flake update`. (The old branch is never rebased: replaying a stale generated lock diff onto a `main` that also moved `flake.lock` conflicts, and the update regenerates the lock from scratch anyway.) If `flake.lock` is unchanged, it exits successfully without pushing. Otherwise it commits `flake.lock`, force-pushes `flake-update` with lease protection, creates the PR if absent, and requests squash auto-merge (one commit per update on `main`, even when the branch carries pipeline fix-ups next to the lock bump).

The updater disables recursive submodule fetching during `git fetch`. This is required because the repository's submodule URL uses GitHub SSH syntax while the service environment is intended to authenticate through HTTPS and the GitHub token.

Manual operation:

```sh
ssh pewter 'systemctl status flake-updater.timer'
ssh pewter 'flake-updater --dry-run'
ssh pewter 'sudo systemctl start flake-updater.service'
ssh pewter 'sudo journalctl -u flake-updater.service -n 100 --no-pager'
```

Use `--dry-run` before investigating an unexpected update. It prints the `flake.lock` diff and does not push, create a PR, or enable auto-merge.

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
2. The failed Build gate job log, if applicable.
3. `systemctl status` and `journalctl` for the updater service on pewter.
4. Watchdog status and the last `flake.lock` commit age.

Do not bypass the Build gate to land an unverified revision. If a service change is needed, send it through a pull request and wait for every `build <system>` check.

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

## Consequences

- Branch protection requiring the gate checks also blocks direct pushes to main; deliberate local work goes through PRs (or admin bypass stays enabled knowingly).
- Bootstrap circularity: the Updater config lives in the repo it pushes to; first install is a manual `nrs pewter`.
- WSL hosts are built but never booted by CI, so runtime breakage there still surfaces on next interactive use.

Status: accepted, partially superseded by 0018 (gate architecture only: one job per host became one job per arch).
