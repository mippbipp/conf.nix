# `~/.agents` ships as a submodule of this repo

Status: accepted.

`mippbipp/.agents` is the user's `~/.agents`
directory. It is a public submodule at `modules/llm/.agents`, pinned by this
repo like every other dependency, and `modules/llm/hm.nix` links it to
`~/.agents` with `config.lib.file.mkOutOfStoreSymlink`, the same mechanism
`modules/hm/devenv/nvim` uses. The symlink points at the host's own
`~/conf.nix` checkout rather than a store copy, so editing the submodule
lands on the next activation without a rebuild, and the commit this repo
records is the version the host runs.

The submodule holds three skill sets:

- `skills/` is global. Agents read `~/.agents/skills` in every directory.
- `matt/` holds project skills, mostly Matt Pocock's, that depend on a
  project's `docs/agents/`, `GLOSSARY.md` or ADRs, or clash with skills a
  project brings. No agent reads it by default. A project opts in with
  `"skills": ["~/.agents/matt"]` in its `opencode.jsonc`; this repo does.
  On a machine without the folder, OpenCode skips the entry silently, so
  template repos can carry the line safely.
- `pstack/` is poteto's pstack, generated for OpenCode from
  `cursor/plugins` by `pstack/src/make-opencode-tree.mjs`. It is global:
  `modules/llm/opencode/app.nix` adds `~/.agents/pstack/skills` as a skill
  source and links its commands, agents and model file into
  `~/.config/opencode/`. Everything outside `pstack/src/` is generator
  output. Changes go in `src/opencode.md` (the OpenCode adapter),
  `src/pstack-models.md` (the model per role) or the generator, never in the
  generated files.

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
  (the `matt` collection is a vendored copy of a third-party skill set).
  Flattening them here loses that provenance and makes upstream updates a
  manual merge. Rejected.
- **Copy project skills into each project, or into the sourdough
  template.** Every project made from the template would freeze its own
  copy, and the copies would drift. Rejected.
- **Symlink project skills into each project's `.agents/skills`.** The link
  points into the user's home, so it breaks in fresh clones, CI, and
  projects created from the template elsewhere. Rejected.
- **Link only `~/.agents/skills` and `~/.agents/matt`, not all of
  `~/.agents`.** Tool files written to `~/.agents` (such as the `npx skills`
  installer's `.skill-lock.json`) would stay out of the repo, but every new
  top-level folder would need its own link. Rejected; a tool file shows up
  as untracked in the submodule, which is the signal to delete it.

## Consequences

- `~/.agents` is a symlink into the host's `~/conf.nix` checkout. If a
  host already has a real `~/.agents` directory, empty it before switching,
  or Home Manager backs it up to `~/.agents.backup`.
- The `matt/` skills only work through OpenCode's `skills` config key.
  Other agents don't see them in opted-in projects.
- Updating the skills means bumping the submodule pointer in this repo.
  Hosts pick the change up with `git submodule sync` and
  `git submodule update --init`.
- Updating pstack means rerunning the generator against a newer
  `cursor/plugins` checkout and committing the result. A second run against
  the same checkout must produce an identical tree (`diff -r`), which shows
  nothing was edited by hand.
- The Build gate's `checks` job leaves submodules uninitialized, because
  the paths resolve out of store at activation time and no check reads
  submodule content.
