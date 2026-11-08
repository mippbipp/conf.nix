# TypeScript programs live in one pnpm workspace beside their Nix modules

Status: accepted.

The repo root is a pnpm workspace with turbo, holding every TypeScript
program the fleet runs that builds with pnpm (`flake-updater` on pewter,
`x-blocklist` on gram). Each package stays in the host or module directory
whose Nix code runs it, rather than in the `apps/` and `packages/` layout of
the sourdough template, and `pnpm-workspace.yaml` lists the packages by
path. The packages share one lockfile, one set of version catalogs (Effect
is pinned once), and one oxlint, oxfmt and anti-slop setup at the root.

Nix never runs turbo. Each package's `package.nix` takes the workspace root
as its source, fetches only its own dependencies with `pnpmWorkspaces`, and
runs that package's typecheck, tests, format and lint in its check phase, so
the Build gate keeps testing every package in a host's closure. Turbo is for
running the same checks on a workstation.

## Considered options

- **One self-contained project per program**, as flake-updater was. Each
  pinned its own Effect and carried its own copy of the lint setup, which
  would drift as programs were added. Rejected.
- **Move the packages into `apps/` and `packages/`.** Matches the template,
  but separates each program from the systemd units, options and ADRs that
  describe it, and breaks paths that workflows and docs reference. Rejected.

## Consequences

- Changing a root file in a package's source set (lockfile, catalogs, lint
  config) rebuilds every package. A dependency change in one package needs
  a new `pnpmDeps.hash` only for packages whose fetched dependencies change.
- Each `package.nix` must list the other packages' `package.json` files in
  its source, because pnpm reads every workspace manifest.
- `modules/llm/opencode/kiro` is a Bun project and stays outside the
  workspace with its own lint setup; the root configs ignore it.
