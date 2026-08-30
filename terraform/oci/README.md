# terraform/oci

OpenTofu stack for the root-tenancy OCI resources backing pewter. The provider
and live resource declarations are present; the resources have been imported
into local state.

## Credentials

`secrets.yaml` contains the OCI tenancy ID, API user OCID, fingerprint, private
key, region, and budget alert recipient. `sops.nix` exposes them under
`/run/secrets/` after the host configuration has been deployed. Export only for
the current OpenTofu shell:

```bash
export TF_VAR_tenancy_ocid="$(< /run/secrets/oci_tenancy_id)"
export TF_VAR_user_ocid="$(< /run/secrets/oci_user_ocid)"
export TF_VAR_fingerprint="$(< /run/secrets/oci_fingerprint)"
export TF_VAR_private_key_path=/run/secrets/oci_private_key
export TF_VAR_region="$(< /run/secrets/oci_region)"
export TF_VAR_budget_alert_email="$(< /run/secrets/oci_budget_alert_email)"
```

## Managed resources

The live root-tenancy resources are managed by the stack:

- VCN, subnet, internet gateway, route table, security list, and DHCP options.
- The pewter instance, its boot volume, and its ephemeral public IP.
- The root-tenancy budget and its alert rule.

Account-wide users, groups, policies, and the NixOS image are intentionally not
managed here.

## Validation

The initial import-aware plan was validated with 11 imports and no creates,
changes, or destroys. Subsequent plans use the persisted local state:

```bash
tofu -chdir=terraform/oci init -upgrade
tofu -chdir=terraform/oci plan
```

Critical resources have `prevent_destroy`. OpenTofu state stays local and is
ignored by git; console changes are emergency-only and must be reconciled into
HCL.
