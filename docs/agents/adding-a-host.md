# Adding A Host

Use this checklist when adding a NixOS host. Replace `<host>` with the
hostname and finish every applicable item before considering the host added.

## Required

1. Add `hosts/<host>/config.nix`. Import the shared system modules that apply
   to the machine and set hardware, platform, boot, networking, and
   `system.stateVersion` here.
2. Add `hosts/<host>/home.nix` and `hosts/<host>/users.nix` when the host has a
   Home Manager profile and local user definition. Copy the smallest existing
   host shape that matches the machine; WSL hosts also need their WSL module
   in `flake.nix`.
3. Add a `nixosConfigurations.<host>` declaration to `flake.nix`. Keep the
   attribute name and the `host = "<host>"` argument identical. Add host-only
   flake modules in this declaration, such as `nixos-wsl` or `lanzaboote`.
4. Add `hosts.<host>` to `modules/fleet.nix`. Use an empty record when no
   other machine needs facts about it; add only cross-host facts and Role
   flags that shared modules consume.
5. Add `<host>` to the matrix in `.github/workflows/build-gate.yml`. The
   runner must match the host platform. The resulting `build <host>` check is
   part of the Build gate.
6. Add `build <host>` to the repository ruleset's required status checks on
   GitHub. This is control-plane state, not a Nix file, and must be updated
   after the first workflow run creates the check.

## Host Surface

1. Add `hosts/<host>/README.md` when bootstrap, disk, firmware, secrets,
   networking, or first-deploy steps are not obvious from the shared README.
   Update the host table and any shared bootstrap instructions in `README.md`.
2. Add host-specific secrets to `secrets.yaml` only when required. Before
   editing it, set `SOPS_AGE_KEY_FILE` to the key path declared in
   `modules/system/config/sops.nix`, and inspect only the encrypted diff.
3. Add an SSH alias or other client binding when the host is reached through a
   non-default address, port, or jump path. Keep machine facts in the fleet
   registry (`modules/fleet.nix`) and consume them from the client configuration.

## Conditional Infrastructure

1. Update `terraform/oci/` when the host needs an OCI instance, volume,
    network rule, or budget. Update `terraform/cloudflare/` when it needs a
    DNS record. Update `terraform/aws-hector/` (isolated local state) and
    `terraform/tailscale/` when the host needs AWS resources or tailnet
    ACL/DNS. Keep provider state and credentials out of the Nix host
    declaration. For example, `hector` added `terraform/aws-hector/` and
    `tag:work` grants in `terraform/tailscale/` (see
    `hosts/hector/README.md` and `docs/adr/0015-hector-work-ec2-dev-machine.md`).
2. Update shared docs or an ADR when adding the host changes a fleet-wide
    invariant, a role definition, the Build gate architecture, or the
    control-plane inventory — e.g., `hector` introduced the `Work host` /
    `Tag isolation` glossary in `CONTEXT.md` and the `build hector` gate.
    A normal host addition does not require editing every document that
    mentions existing host names.

## Verify

Run the following from the repository root:

```sh
nix flake check
nix build ".#nixosConfigurations.<host>.config.system.build.toplevel"
```

Then confirm all of these are true: the host evaluates and builds, the
`build <host>` check passes on a pull request, the check is required by the
main ruleset, and the host's bootstrap or deployment procedure is documented.

## Derived Surfaces

Do not add a host to these just because it exists:

- `modules/hm/devenv/scripts/nrs.nix` derives remote build hosts from the
  `remoteBuilds` Role flag in the fleet registry.
- Shared system and Home Manager modules are imported by the host files; they
  do not maintain a host allowlist.
- Attic substitution applies to all NixOS hosts through the shared Nix module.

Edit a derived surface only when the new host changes its documented rule.
