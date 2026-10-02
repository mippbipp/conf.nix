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
watchdog, state directories, and recovery evidence to collect.

## Encrypted secrets

Before editing `secrets/me.yaml`, set `SOPS_AGE_KEY_FILE=<filepath from modules/system/config/sops.nix>` in the command environment. Verify the encrypted diff afterward and keep decrypted values out of command output.

## What you need from me

- End every turn where you're blocked on me, or where the next step needs me, with a short "**What I need from you**" section. Numbered, one concrete action per item: exactly what to do, where (which site, app, file or person), and what to send back. e.g. "Log into CommBank NetBank and export Jan to Jun 2026 as CSV, then drop it in `inbox/`", not "I need the bank data".
- If there are several, put the quickest or most blocking one first, and say what you'll get on with in the meantime.
- If you don't need anything from me, say "Nothing needed from you right now" so I don't have to ask.
- Never bury a request for me in the middle of a long update.
