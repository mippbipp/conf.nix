# Shared agent skills ship as a submodule of this repo

Status: accepted.

`mippbipp/skills` holds the shared agent skills the fleet reads. It is a
public submodule at `modules/llm/skills`, pinned by this repo like every
other dependency, and `modules/llm/hm.nix` links it to `~/.agents/skills`
with `config.lib.file.mkOutOfStoreSymlink`, the same mechanism
`modules/hm/devenv/nvim` uses. The symlink points at the host's own
`~/conf.nix` checkout rather than a store copy, so editing the submodule
lands on the next activation without a rebuild, and the commit this repo
records is the version the host runs.

Pinning makes the skills a reviewed input like the rest of the
configuration: every host runs the same recorded commit, and a change to a
skill shows up as a pointer bump in this repo.

## Considered options

- **Clone the skills repo and pull `main` on a timer.** A mirror has no
  version: what a host ran would depend on when the timer last fired, hosts
  could differ by days, and a change to a skill would never be reviewable
  here. Rejected.
- **Copy the skills into the store** (a normal `home.file` source rather
  than an out-of-store symlink). The skills would be frozen at build time,
  so editing them needs a rebuild on every host, which is the property the
  `nvim` submodule was moved away from. Rejected.
- **Vendor the skills into this repo as plain files.** The skills have
  their own history, their own `skills-lock.json`, and their own upstream
  (the `matt` and `effect` collections are vendored copies of third-party
  skill sets). Flattening them here loses that provenance and makes
  upstream updates a manual merge. Rejected.

## Consequences

- `~/.agents/skills` is a symlink into the host's `~/conf.nix` checkout.
- Updating the skills means bumping the submodule pointer in this repo.
  Hosts pick the change up with `git submodule update`.
- The Build gate's `checks` job leaves submodules uninitialized, because
  the paths resolve out of store at activation time and no check reads
  submodule content.
