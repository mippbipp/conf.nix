# hector is a tailnet-only work EC2 host isolated by tags and hardening

`warpe` needed a NixOS dev machine reachable from both the work laptop and `gram` without mixing work and personal AWS resources or requiring admin access. We add `hector` as a Graviton EC2 host provisioned with `nixos-anywhere` and `disko`, tailnet-only after bootstrap, isolated by a dedicated AWS namespace and `tag:work` grants, and hardened as a Work host with no shared age identity, pull-only cache, and no things sync.

## Considered options

- Graviton vs x86_64: Graviton wins on perf per cost; the fleet already has aarch64 and cross-builds are covered by remote builders.
- LUKS vs EBS encryption: dropped LUKS on EC2; EBS encrypts at rest and an initrd SSH unlock adds friction.
- Tailnet-only vs public SSH: tailnet-only removes SG exposure; a temporary public IP is used only for `nixos-anywhere`.
- Least-privilege profile vs AdministratorAccess: scoped to SSM, EKS, and describe; full admin on a 24/7 instance profile is too broad.
- Shared age identity vs isolated: shared would let a work-admin snapshot decrypt personal secrets, so `hector` carries no shared key and no personal sops secrets.
- Flat mesh vs tag isolation: flat would let `hector` reach personal hosts; tag isolation restricts it to `warpe`/`gram` -> `hector` and `hector` -> `pewter`/`internet`.
- Ephemeral auth key vs persisted: one-use tagged key deleted after first connect; no auth material remains on disk.

## Consequences

- `hector` is declared like other hosts but imports no shared sops secrets and holds only `warpe`'s pubkey. It is built on `ubuntu-24.04-arm` and required by the branch ruleset.
- Tailnet policy owns `tag:work` and its grants. `hector` pulls from the public Attic cache; deployments go via `nrs hector` from `warpe` or `pewter`.
- The AWS stack is a separate local-state OpenTofu root, not part of `terraform/oci`. Resizing is a volume modify plus filesystem resize; `stop` keeps the volume, `terminate` is decommission.

Status: accepted
