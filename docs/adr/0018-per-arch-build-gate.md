# Per-arch Build gate jobs share one store per runner

Supersedes the gate-architecture portion of 0009; the rest of that ADR still holds.

The Build gate (ADR 0009) ran one job per host. Each job has an isolated
`/nix/store` and all jobs in a PR run in parallel, so two hosts of the same
arch wanting the same derivation both miss the Attic cache and both compile
it. Today only `gram` uses the CachyOS kernel, so nothing duplicates yet —
but a second DE host cloning `gram`'s config (kernel included) would rebuild
that kernel from scratch in its own job while `gram` builds it next door.

One job per arch builds every host of that arch in a single `/nix/store`:
shared derivations compile once and hit locally for the remaining hosts.
The job enumerates its hosts from the flake at CI time
(`nixosConfigurations` filtered by `config.nixpkgs.hostPlatform.system`),
builds each toplevel with a per-host `--out-link result-<host>`, keeps a
failure accumulator so one broken host does not mask another (the old
`fail-fast: false` signal), and pushes every per-host closure to Attic
(Attic dedups shared paths server-side). Per-host failure attribution lives
in grouped `build <host>` log sections rather than in separate check names.

Operational details live in `docs/agents/flake-update-pipeline.md`; this ADR
records the rationale for the per-arch shape.

Why this shape: the duplicate-work unit is the derivation, and the sharing
scope is the runner's store — so the fix is structural (share the store),
not ordering (`needs:` chains serialize the long pole) and not source
policy (constraining kernel choice to dodge a CI race). Enumeration keeps
the invariant "everything used by every host builds" without per-host YAML:
adding a host of a covered arch touches zero CI files.

## Considered options

- **Order + substitute** (`build gram` first, `needs:` then `build gram2`):
  the second job substitutes the kernel from Attic instead of compiling.
  Minimal YAML change, but serializes the x86_64 lane and only helps when
  the first job finishes pushing before the second needs the path. Rejected
  as the mechanism; the shared store gives the same hit without ordering.
- **Source reduction** (align on a kernel with an upstream binary cache):
  stops building the kernel at all, but constrains kernel policy to serve
  CI and does nothing for the next shared derivation that isn't a kernel.
  Separate decision, not a substitute.
- **Synthetic per-host check-runs** fanned out from the arch job via the
  Checks API: preserves `build <host>` names in the GitHub UI, but buys a
  bespoke reporting shim the deployer and `build-matrix-sync` must then
  trust. The shim is more code than the dedup it serves. Rejected.

## Consequences

- Required checks change from five `build <host>` to two `build <system>`
  (`build x86_64-linux`, `build aarch64-linux`). The GitHub ruleset is
  control-plane state and must be updated alongside the merge, after the
  first workflow run creates the new checks.
- Adding a host of an already-covered arch needs no Build gate edit; a new
  arch needs one `- system:` matrix row plus its ruleset entry.
  `build-matrix-sync` enforces coverage (every declared host's system has a
  job; no job covers zero hosts) instead of the old host-row pinning.
- The Deployer needs no logic change: its `startswith("build ")` lookup
  matches the arch check names, and per-host coverage is enforced pre-merge.
- Failure attribution moves from check names to grouped log sections; the
  recovery runbook points at the arch job log first.
