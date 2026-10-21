# Role flags select their implementations

Status: accepted. Extends ADR-0010; its static host declaration and typed
records still hold.

A Role flag in `modules/fleet/registry.nix` is all a host sets to get a
capability. `modules/fleet/system.nix` (NixOS) and `modules/fleet/hm.nix` (Home
Manager) select the implementation, both imported by `flake.nix` for every host.
Host files carry no role imports.

Before this, `usesWorkGit = true` described nothing: each host also hand-added
two import lines, and both consumers were already guarded
(`lib.mkIf (flag && pathExists …)`), so a forgotten import was silent: a host
could commit under `~/work/` with the personal identity, the failure ADR-0019
exists to prevent. `acceptsSsh` had the same shape.

## Considered options

- **Conditional import** (`imports = lib.optional flag ./impl.nix`): rejected.
  `imports` must be a list of modules, and branching it on `config` recurses.
  Resolving imports needs the config still being assembled, so NixOS reports
  "infinite recursion encountered".
- **Conditional import off a specialArg**: works on the Home Manager side, where
  records arrive as plain data through `extraSpecialArgs`. Rejected for
  inconsistency, and because a wrongly-branched import does nothing at all. An
  unconditional import plus `lib.mkIf` cannot be forgotten.
- **A shared flag-to-module table** for both adapters: rejected. With no branch
  left to share, the two adapters are the seam and a third file would restate
  them.

## Consequences

- Adding a host needs no role imports. Step 4 of
  `docs/agents/adding-a-host.md` is the whole story.
- `isPersonalHost` (opt-in, default false) gates the personal secret list.
  `sops.age.keyFile` and `defaultSopsFile` still evaluate on every host because
  hosts carrying the work-only file decrypt through the same key path; whether
  the shared age key is installed is a deploy-time fact, not something Nix
  config can assert. Distinct from `isWorkPc`, a DNS role.
- `modules/ssh/system.nix` was a no-op (`enable = false`, the nixpkgs default,
  imported by one host that never enabled sshd) while sshd hosts hand-wrote
  identical hardening. Hardening is now fleet-wide and reachability is
  flag-gated, so no host weakens by enabling sshd later. This widens the config:
  `gram` gains `PermitRootLogin = "prohibit-password"` and the two WSL guests gain
  `PasswordAuthentication = false`, both inert while sshd is off.
- Three checks assert each flag against the built config in both directions for
  every host: `work-identity-wiring`, `sshd-wiring`, `personal-secrets-wiring`.
  They assert effect, not structure, so they hold however a host is wired.
  `work-identity-wiring` probes the Home Manager side because NixOS
  `sops.secrets` stays empty until `secrets/work.yaml` is provisioned and so
  cannot tell "flag off" from "file missing".
- Repo-relative Home Manager paths (e.g. nvim, hyprland, skills) resolve out-of-store from
  the host's `~/conf.nix` checkout.
