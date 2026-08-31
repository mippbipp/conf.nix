# Verified Flake Update Pipeline

This repository updates `flake.lock` from pewter and merges only revisions
that pass the four-host Build gate. The design rationale is in
`docs/adr/0009-flake-update-pipeline.md`; this document is the operational
runbook and implementation reference.

## Pipeline

The sequence is:

1. `flake-updater.timer` runs daily on pewter with persistence and a 30-minute
   randomized delay.
2. `flake-updater.service` runs as the configured pewter user, updates a
   clone in `/var/lib/flake-updater`, and maintains one `flake-update` branch
   and pull request.
3. GitHub Actions runs `.github/workflows/build-gate.yml` for every pull
   request. Its required checks are `build gram`, `build harpe`, `build warpe`,
   and `build pewter`.
4. GitHub auto-merge is enabled by the Updater, but merge waits for all four
   required checks to pass.
5. `flake-deployer.timer` runs around 03:00 on pewter with persistence and a
   30-minute randomized delay.
6. `flake-deployer.service` verifies the merged revision, switches pewter,
   and runs the health gate.
7. `.github/workflows/watchdog.yml` runs Mondays at 09:00 UTC and fails when
   the latest `flake.lock` commit is more than seven days old.

## Updater

The Updater reads the GitHub token from the SOPS secret
`github_token`. It keeps GitHub's credential helper in the updater checkout's
`.gitconfig`, rather than changing the user's Home Manager-managed global Git
configuration. It also sets the commit identity explicitly.

Each run resets the local branch to `origin/main`, rebases an existing
`origin/flake-update` branch onto it, and runs `nix flake update`. If
`flake.lock` is unchanged, it exits successfully without pushing. Otherwise
it commits `flake.lock`, force-pushes `flake-update` with lease protection,
creates the PR if absent, and requests rebase auto-merge.

The updater disables recursive submodule fetching during `git fetch`. This is
required because the repository's submodule URL uses GitHub SSH syntax while
the service environment is intended to authenticate through HTTPS and the
GitHub token.

Manual operation:

```sh
ssh pewter 'systemctl status flake-updater.timer'
ssh pewter 'flake-updater --dry-run'
ssh pewter 'sudo systemctl start flake-updater.service'
ssh pewter 'sudo journalctl -u flake-updater.service -n 100 --no-pager'
```

Use `--dry-run` before investigating an unexpected update. It prints the
`flake.lock` diff and does not push, create a PR, or enable auto-merge.

## Build Gate

The Build gate builds each system's full toplevel closure:

```sh
nix build ".#nixosConfigurations.<host>.config.system.build.toplevel"
```

`gram`, `harpe`, and `warpe` use x86_64 runners. `pewter` uses
`ubuntu-24.04-arm`. The workflow initializes submodules after rewriting
GitHub SSH URLs to HTTPS and uses the public fleet Attic cache for
substitution. Successful same-repository PR builds may push their closure to
that cache.

When a check fails, inspect the specific job log before changing the
pipeline. A PR must have all four successful checks before it is eligible for
auto-merge.

## Deployer

The Deployer uses `/var/lib/flake-deployer` and reads the same SOPS GitHub
token. It fetches `main` with recursive submodule fetching disabled, then
initializes submodules with this rewrite:

```text
git@github.com: -> https://github.com/
```

Before switching, it:

1. Resolves the pull request associated with the current `main` commit.
2. Reads that PR's `headRefOid`.
3. Checks the four Build gate conclusions on that head commit.
4. Stops if the merged commit has no associated PR or any check is absent or
   unsuccessful.

The check lookup uses the PR head commit because a rebase merge creates a new
main commit that may not have its own GitHub check runs.

The switch uses NixOS's setuid wrapper, not the unprivileged `sudo` binary in
the Nix store:

```sh
/run/wrappers/bin/sudo nixos-rebuild switch --flake ".?submodules=1#pewter"
```

The service records `/run/current-system` before switching. If the rebuild
fails, it switches back to that generation. After a successful switch it
requires:

- `tailscale status` to succeed
- `t3code.service` to be active
- `sshd.service` to be active

If any probe fails, it switches back, adds or updates a marked health-gate
comment on the PR, and exits unsuccessfully.

Manual operation:

```sh
ssh pewter 'sudo systemctl status flake-deployer.timer'
ssh pewter 'sudo systemctl start flake-deployer.service'
ssh pewter 'sudo systemctl status flake-deployer.service --no-pager'
ssh pewter 'sudo journalctl -u flake-deployer.service -n 100 --no-pager'
```

Completion requires `status=0/SUCCESS`, an active timer, and successful
health probes in the service journal. A successful `nixos-rebuild` alone is
not sufficient evidence.

## Watchdog

The Watchdog checks the newest commit touching `flake.lock`. It runs on its
Monday schedule and can also be dispatched manually:

```sh
gh workflow run update-watchdog
gh run list --workflow update-watchdog --limit 1
gh run watch <run-id> --exit-status
```

The required evidence is a completed run with conclusion `success` and a
recent-lock message. A failure means the Updater may be stale even if both
systemd timers still exist.

## Recovery And Evidence

For a failed update or deployment, collect evidence in this order:

1. `gh pr view <number>` and `gh pr checks <number>`.
2. The failed Build gate job log, if applicable.
3. `systemctl status` and `journalctl` for the relevant pewter service.
4. The current and previous NixOS generations if a switch occurred.
5. Watchdog status and the last `flake.lock` commit age.

Do not bypass the Build gate to deploy an unverified revision. If a service
change is needed, send it through a pull request and wait for all four checks
before retrying the Deployer.

## Host Changes

When adding a host, update the Build gate matrix and the GitHub ruleset's
required checks in addition to the NixOS host declarations. Follow
`docs/agents/adding-a-host.md`; the matrix entry and required check are part
of the verification invariant.
