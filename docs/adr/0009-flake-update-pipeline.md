# Flake updates verified by a build gate before merge

The old `update-flake-lock` workflow opened a PR and enabled auto-merge unconditionally, so an eval-broken lock bump could land on main overnight. We replace it with a split pipeline whose invariant is: **main is always buildable for every NixOS host** (gram, harpe, warpe, pewter).

- **Updater** (systemd timer on pewter): rebases its clone on origin/main, runs `nix flake update`, exits cleanly when the lock didn't change, otherwise force-pushes the stable `flake-update` branch and creates-or-updates the single accumulating PR.
- **Build gate** (GitHub Actions, free runners — the repo is public): one job per host builds `nixosConfigurations.<host>.config.system.build.toplevel`; gram/harpe/warpe on x86_64 runners, pewter on `ubuntu-24.04-arm`. These checks are required for merge.
- **Merge**: GitHub auto-merge fires only once the gate is green; failed days just leave the PR red until a later bump goes green.
- **Deployer** (systemd timer on pewter): pulls main, `nixos-rebuild switch` (a no-op when nothing changed), then a health gate probes tailscale, t3code, and sshd; on failure it rolls back to the previous generation and comments on the just-merged PR so default GitHub notifications surface it.
- **Watchdog** (weekly Actions job): fails — and therefore emails — if the last committed lock update is older than ~7 days, covering silent Updater death (expired credentials, dead timer) where no other channel fires.

Why this shape: verification needs native x86_64 *and* aarch64 compute; GitHub provides both free for public repos, while pewter is always-on and already git-authenticated, making it the natural orchestrator and deploy target. Testing happens entirely pre-merge on runners; pewter's own rebuild happens post-merge because activation can only be exercised by deploying, and the health gate plus rollback bounds the blast radius of a bad activation on the exit-node/remote-workspace host.

## Considered options

- **Pure pewter pipeline** (no Actions at all): elegant, but x86_64 hosts could only be eval-checked under emulation or not at all — downgrades the invariant from "buildable" to "evaluable". Rejected.
- **Self-hosted garnix-ci** (open-sourced after their shutdown): gives orchestration, not builders — we'd still need x86_64 compute behind it, plus a Haskell backend, database, and registered GitHub App for one personal repo. Disproportionate. Rejected.
- **Actions-only** (the status quo ante): no persistent orchestrator, and pre-pipeline it merged unverified. The updater role belongs somewhere always-on. Superseded.

## Consequences

- Branch protection requiring the gate checks also blocks direct pushes to main; deliberate local work goes through PRs (or admin bypass stays enabled knowingly).
- Bootstrap circularity: the Updater config lives in the repo it pushes to; first install is a manual `nrs pewter`.
- WSL hosts are built but never booted by CI — runtime breakage there still surfaces on next interactive use.
