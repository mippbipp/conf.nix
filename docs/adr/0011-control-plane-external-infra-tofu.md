# External infrastructure is owned by the OpenTofu control plane

## Decision

Externally owned state that outlives a device belongs to the OpenTofu control
plane, with one local state per provider stack. NixOS remains the source of
truth for device configuration and service configuration.

This currently applies to:

- Tailnet policy and DNS in `terraform/tailscale/`.
- The `mippbipp.com` zone and its DNS records in `terraform/cloudflare/`.

The OCI stack in `terraform/oci/` owns the root-tenancy resources dedicated to
pewter: VCN, subnet, gateways, route table, security list, DHCP options,
ephemeral public IP, instance, boot volume, and budget alerts. The account has
no dedicated pewter compartment. Account-wide IAM and unrelated tenancy
resources remain outside this stack.

## OCI migration

The OCI migration is complete: provider and live resource declarations exist
in `terraform/oci/`, and the live resources have been imported into local
state. Migration proceeded in this order:

1. Inventory all root-tenancy pewter resources and their dependencies.
2. Add the provider configuration and resource declarations without applying
   them. The initial plan declared 11 imports.
3. Add OCI credentials to `secrets.yaml`, expose them through `sops.nix`, and
   export them only for OpenTofu commands.
4. Import every live resource into local OpenTofu state.
5. Require a reviewed plan with no unexpected creates, replacements, or
   destroys before the first apply.
6. Re-run the plan until the declared configuration and imported state agree.

The first migration pass was import-and-plan only. OpenTofu is now the source
of truth. Console changes are reserved for emergencies and must be reconciled
into HCL afterward.

## Safety boundaries

- State remains local under `terraform/oci/` and is ignored by git.
- OCI credentials and private keys remain SOPS-managed and out of HCL/state
  inputs committed to the repository.
- `prevent_destroy` guards protect critical networking,
  ephemeral public IP, instance, and boot volume. Budget and IAM resources need
  explicit review before any destructive change.
- The OCI image remains ignored after the Ubuntu-to-NixOS migration; NixOS
  owns the guest operating system.

## Alternatives

CDKTF and a shared multi-provider state were rejected. CDKTF adds a synthesis
toolchain, while shared state couples unrelated tailnet, DNS, and pewter
changes and increases the blast radius of a mistake.
