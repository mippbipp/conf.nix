# Flake updates verified by a build gate before merge

The old `update-flake-lock` workflow opened a PR and enabled auto-merge unconditionally, so an eval-broken lock bump could land on main overnight. We replace it with a split pipeline whose invariant is: **main is always buildable for every NixOS host** (every `nixosConfigurations.<host>` entry).

- **Updater** (systemd timer on pewter, Mondays ~02:00): rebases its clone on origin/main, runs `nix flake update`, exits cleanly when the lock didn't change, otherwise force-pushes the stable `flake-update` branch and creates-or-updates the single accumulating PR.
- **Build gate** (GitHub Actions, free runners — the repo is public): one job per host builds `nixosConfigurations.<host>.config.system.build.toplevel` with a runner matching the host platform. These checks are required for merge and use the public fleet Attic cache for substitution.
- **Merge**: GitHub auto-merge fires only once the gate is green; failed weeks just leave the PR red until a later bump goes green.
- **Watchdog** (monthly Actions job, 1st at 09:00 UTC): fails — and therefore emails — if the last committed lock update is older than ~30 days, covering silent Updater death (expired credentials, dead timer) where no other channel fires.

Operational details live in `docs/agents/flake-update-pipeline.md`; this ADR records the rationale and the cadence/host-coverage decisions.

Why this shape: verification needs native x86_64 *and* aarch64 compute; GitHub provides both free for public repos, while pewter is always-on and already git-authenticated, making it the natural orchestrator and deploy target. Testing happens entirely pre-merge on runners; pewter's own rebuild happens post-merge because activation can only be exercised by deploying.

## Considered options

- **Pure pewter pipeline** (no Actions at all): elegant, but x86_64 hosts could only be eval-checked under emulation or not at all — downgrades the invariant from "buildable" to "evaluable". Rejected.
- **Self-hosted garnix-ci** (open-sourced after their shutdown): gives orchestration, not builders — we'd still need x86_64 compute behind it, plus a Haskell backend, database, and registered GitHub App for one personal repo. Disproportionate. Rejected.
- **Actions-only** (the status quo ante): no persistent orchestrator, and pre-pipeline it merged unverified. The updater role belongs somewhere always-on. Superseded.

## Consequences

- Branch protection requiring the gate checks also blocks direct pushes to main; deliberate local work goes through PRs (or admin bypass stays enabled knowingly).
- Bootstrap circularity: the Updater config lives in the repo it pushes to; first install is a manual `nrs pewter`.
- WSL hosts are built but never booted by CI — runtime breakage there still surfaces on next interactive use.

Status: accepted, partially superseded by 0018 (gate architecture only — one job per host became one job per arch).
