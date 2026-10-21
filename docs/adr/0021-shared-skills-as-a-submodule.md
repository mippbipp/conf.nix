# Shared agent skills ship as a submodule of this repo

Status: accepted. Supersedes the `skills-sync` mirror described in 0020.

`mippbipp/skills` holds the shared agent skills the fleet reads. It used to
reach hosts two ways at once: a private clone that each host pulled on a
timer (`modules/hm/devenv/skills-sync`), and nothing else. The timer owned
`~/.agents/skills` outright, pulling `main` every five minutes, so what a
host ran depended on when the timer last fired rather than on any commit
this repo could point at.

It is now a submodule at `modules/llm/skills`, pinned by this repo like
every other dependency, and `modules/llm/hm.nix` links it into place with
`config.lib.file.mkOutOfStoreSymlink`, the same mechanism `modules/hm/devenv/nvim`
already uses. The symlink points at the host's own `~/conf.nix` checkout
rather than a store copy, so editing the submodule lands on the next
activation without a rebuild, and the commit this repo records is the
version the host runs.

Why a submodule and not a mirror: a mirror has no version. The timer
pulled `main` on its own schedule, so a host's skills could differ from
another host's by days, and a change to a skill was never reviewable in
this repo. Pinning it makes the skills a reviewed input like the rest of
the configuration, and the per-host update path is the same
`git submodule update` the `nvim` submodule already uses.

The submodule is private, which constrains two things. The Build gate
cannot fetch it: `GITHUB_TOKEN` covers `mippbipp/conf.nix` only, so the
`checks` job leaves submodules uninitialized. That is already how the
`build-closure` job works, and the checks do not read submodule content,
because the paths resolve out of store at activation time rather than at
build time. The second constraint is host-side: a host that clones this
repo needs SSH access to `mippbipp/skills`. The `skills-sync` module
already documented a per-host deploy key for exactly this case
(`~/.ssh/<host>_skills_ed25519`), and that key still applies, now to the
submodule clone rather than to a timer pull.

## Considered options

- **Keep the timer mirror and add the submodule alongside it.** Two
  mechanisms owning one path, and the timer would `git pull` inside the
  submodule checkout and move it off the pinned commit. Rejected.
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

- `~/.agents/skills` is now a symlink into the host's `~/conf.nix`
  checkout. On a host that already had the old timer clone at that path,
  Home Manager moves the clone to `~/.agents/skills.backup` and links the
  symlink in its place (`backupFileExtension` is set).
- Updating the skills means bumping the submodule pointer in this repo, not
  waiting for a timer. Hosts pick the change up with
  `git submodule update`.
- The `skills-sync` module and its README are gone. The per-host deploy
  key guidance moved to this ADR and to the clone instructions.
- The Build gate's `checks` job no longer fetches submodules. Anything
  that later needs submodule *content* at build time (a check reading a
  file inside `modules/llm/skills`, say) would need a token that can read
  `mippbipp/skills`, which the default `GITHUB_TOKEN` cannot provide.
