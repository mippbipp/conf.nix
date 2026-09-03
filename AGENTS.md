# Agent skills

Declarative NixOS/home-manager configuration for the host machines in hosts/.

## Issue tracker

Issues and PRDs live in GitHub Issues. External PRs are treated as a triage surface. See `docs/agents/issue-tracker.md`.

## Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

When adding a host, read `docs/agents/adding-a-host.md` first. It lists the
required declaration, Build gate, GitHub ruleset, documentation, and
conditional infrastructure surfaces.

When changing, diagnosing, or operating the flake update pipeline, read
`docs/agents/flake-update-pipeline.md`. It defines the updater, Build gate,
deployer, watchdog, state directories, and recovery evidence to collect.

## Encrypted secrets

Before editing `secrets.yaml`, set `SOPS_AGE_KEY_FILE=<filepath from modules/system/config/sops.nix>` in the command environment. Verify the encrypted diff afterward and keep decrypted values out of command output.
