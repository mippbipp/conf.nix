# TypeScript programs live in one Bun workspace beside their Nix modules

Status: accepted. Amended: the workspace moved from pnpm and Node.js to Bun,
as the sourdough template did.

The repo root is a Bun workspace with turbo, holding every TypeScript
program the fleet runs (`flake-updater` on pewter, `x-blocklist` on gram).
Each package stays in the host or module directory whose Nix code runs it,
rather than in the `apps/` and `packages/` layout of the sourdough template,
and the `workspaces` field of the root `package.json` lists the packages by
path. The packages share one `bun.lock`, one set of version catalogs (Effect
is pinned once), and one oxlint, oxfmt and anti-slop setup at the root.
Programs run on Bun, with `@effect/platform-bun` as the Effect platform.

Nix never runs turbo. Each package's `package.nix` takes the workspace root
as its source and installs dependencies with bun2nix: `bun.nix`, generated
from `bun.lock`, lists every package with its registry hash, and
`bun2nix.fetchBunDeps` plus `bun2nix.hook` build Bun's cache from it and run
`bun install` offline. Its check phase runs that package's
typecheck, tests, format and lint, so the Build gate keeps testing every
package in a host's closure. Turbo is for running the same checks on a
workstation.

## Considered options

- **One self-contained project per program**, as flake-updater was. Each
  pinned its own Effect and carried its own copy of the lint setup, which
  would drift as programs were added. Rejected.
- **Move the packages into `apps/` and `packages/`.** Matches the template,
  but separates each program from the systemd units, options and ADRs that
  describe it, and breaks paths that workflows and docs reference. Rejected.
- **Stay on pnpm and Node.js.** nixpkgs has `fetchPnpmDeps` and no fetcher
  for `bun.lock`, so pnpm needed no extra flake input. Bun matches the
  sourdough template and the opencode plugin, and drops Node.js from the
  closures. Rejected in favour of the template.
- **A fixed-output derivation that runs `bun install`**, as nixpkgs packages
  opencode. It needs no extra input, but its one opaque hash has to be
  updated in every `package.nix` on any lockfile change, and only a build
  shows whether Bun installed the same files on both architectures.
  bun2nix pins each package by its registry hash instead, as vicinae-dgpu
  does. Rejected.

## Consequences

- Changing a root file in a package's source set (lockfile, catalogs, lint
  config) rebuilds every package.
- `bun.nix` must be regenerated and committed with every `bun.lock` change.
  The root `postinstall` runs `bun2nix -o bun.nix` when `bun2nix` is on
  `PATH`, which `nix develop` provides. A stale `bun.nix` fails the build.
- The `bun2nix` input pins Mic92's fork, because bun2nix 2.1.2 rejects the
  lockfileVersion 2 that Bun 1.4 writes (nix-community/bun2nix#110). Move
  back to nix-community/bun2nix once that merges.
- Package scripts start with `#!/usr/bin/env node`. The builds run them with
  `bun --bun`, so no Node.js enters the build or the output.
- `package.json` can't hold comments, so two notes from the old
  `pnpm-workspace.yaml` live here. `overrides.effect` keeps one Effect copy,
  because `@opencode/client`'s schema and protocol packages pin `effect`
  directly and the client's decoded values must come from the same module
  instances as the workspace's runtime. `@effect/tsgo` patches oxlint and
  supports only the versions it lists, so bump the `oxlint` catalog entry
  only to a version the installed `@effect/tsgo` accepts.
- `modules/llm/opencode/kiro` is a separate Bun project with its own
  lockfile and lint setup; the root configs ignore it.
