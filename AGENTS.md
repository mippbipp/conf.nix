# Agent skills

Declarative NixOS/home-manager configuration for the host machines in hosts/.

## Issue tracker

Issues and PRDs live in GitHub Issues. External PRs are treated as a triage surface. See `docs/agents/issue-tracker.md`.

## Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Single-context repo, one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

When adding a host, read `docs/agents/adding-a-host.md` first. It lists the
required declaration, Build gate, GitHub ruleset, documentation, and
conditional infrastructure surfaces.

When changing, diagnosing, or operating the flake update pipeline, read
`docs/adr/0009-flake-update-pipeline.md`. It defines the updater, Build gate,
watchdog, state directories, and recovery evidence to collect.

## Testing changes on a host

`sudo` is passwordless on every host, so you can run `nrs` (see `GLOSSARY.md`)
yourself to apply a change to the host you're running on. Check that it builds
first with
`nix build ".#nixosConfigurations.<host>.config.system.build.toplevel"`.
`nrs` switches the live system and always builds from `~/conf.nix`, so changes
made in another worktree must land there first. Nix ignores untracked files,
so `git add` new ones. Ask before running `nrs <host>` against any other host.

## TypeScript workspace

This repo uses bun (`packageManager` in `package.json`). When a skill or doc
says `npm`, `npx`, `pnpm` or `yarn`, use `bun` or `bunx` instead.

Lint, format and typecheck with `bun run ox`; fix with `bun run ox:fix`.

`bun.lock` changes must be committed together with the regenerated `bun.nix`.
`bun install` regenerates it through the root `postinstall` when `bun2nix` is
on `PATH` (`nix develop` provides it). Otherwise run `bun2nix -o bun.nix`.

This repo uses Effect 4. Before writing any Effect code, read
`node_modules/effect/AGENTS.md` **completely**, and follow the links in the
file when required. For APIs the guide doesn't cover, search the source in
`node_modules/effect/src`.

Before changing `turbo.jsonc` or turbo commands, read `docs/README.md` in the
installed `turbo` package (find it with
`bun -p "require.resolve('turbo/package.json')"`), then the pages it points to.

Use `agent-browser` for browser automation. Before the first use, run
`agent-browser skills get core` and follow it.

## GitHub Actions

`.github/workflows/actions.lock` pins every action to a commit SHA, and the
`actions-lock` Build gate job verifies it. After changing any `uses:` line, run
`gh actions-lock` and commit the updated lockfile.

## Encrypted secrets

Before editing `secrets/me.yaml`, set `SOPS_AGE_KEY_FILE=<filepath from modules/system/config/sops.nix>` in the command environment. Verify the encrypted diff afterward and keep decrypted values out of command output.
