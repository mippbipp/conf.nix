# Role flags select their implementations

Status: accepted. Extends ADR-0010; its static host declaration and typed
records still hold.

A Role flag in `modules/fleet/registry.nix` is all a host sets to get a
capability. `modules/fleet/system.nix` (NixOS) and `modules/fleet/hm.nix` (Home
Manager) select the implementation, both imported by `flake.nix` for every host.
Host files carry no role imports.

Before this, `usesWorkGit = true` described nothing: each host also hand-added
two import lines, and both consumers were already guarded
(`lib.mkIf (flag && pathExists …)`), so a forgotten import was silent. A Work host
missing its work sops module would commit under `~/work/` with the personal
identity, the failure ADR-0019 exists to prevent. `acceptsSsh` and
`hasRepoCheckout` had the same shape.

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
- `isPersonalHost` (new, opt-in, default false) gates the personal secret list,
  so a Work host declares none of it. Narrower than ADR-0015's wording:
  `hector` still evaluates `sops.age.keyFile` and `defaultSopsFile` and has
  `sops`/`age` on `$PATH`, because it decrypts the work file with the same key
  path. Whether the shared age key is installed is a deploy-time fact, not
  something Nix config can assert. Distinct from `isWorkPc`, a DNS role.
- `nrs` is no longer installed on a host without a checkout. It built from
  `/home/${username}/conf.nix`, which `hector` does not have, so plain `nrs`
  there pointed at a directory the registry says should not exist. `hector` keeps
  a rebuild path: `nrs hector` from a host that has a checkout, which ADR-0015
  already describes.
- `modules/ssh/system.nix` was a no-op (`enable = false`, the nixpkgs default,
  imported by one host that never enabled sshd) while the two hosts running sshd
  hand-wrote identical hardening. Hardening is now fleet-wide and reachability is
  flag-gated, so no host weakens by enabling sshd later. This widens the config:
  `gram` gains `PermitRootLogin = "prohibit-password"` and the two WSL guests gain
  `PasswordAuthentication = false`, both inert while sshd is off.
- Four checks assert each flag against the built config in both directions for
  every host: `work-identity-wiring`, `sshd-wiring`, `personal-secrets-wiring`,
  `checkout-wiring`. They assert effect, not structure, so they hold however a
  host is wired. `work-identity-wiring` probes the Home Manager side because NixOS
  `sops.secrets` stays empty until `secrets/work.yaml` is provisioned and so
  cannot tell "flag off" from "file missing".
- Repo-relative Home Manager paths (nvim, hyprland) resolve from the store
  unless `hasRepoCheckout`, so a checkout-free host gets no dangling symlink.
  `skills-sync` keeps its runtime `ConditionPathExists`: the flag says a host is
  designed without a checkout, the condition asks whether one is cloned now.