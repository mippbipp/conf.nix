# terraform/cloudflare

Source of truth for `mippbipp.com` zone and `cache.mippbipp.com -> 129.146.202.171` as **Control plane** (`CONTEXT.md`, ADR-0011). Zone and `cache` were imported from the prior manual DNS; tofu now owns them — do not edit in the Cloudflare console.

Upstream `nginx` on pewter terminates TLS (`hosts/pewter/attic.nix` `enableACME`).

## Credentials

`CLOUDFLARE_API_TOKEN` and `cloudflare_account_id` are in `secrets.yaml` via `sops.nix` (`modules/system/config/sops.nix`). Export before tofu:

```bash
export CLOUDFLARE_API_TOKEN="$(sudo cat /run/secrets/cloudflare_api_token)"
export TF_VAR_cloudflare_account_id="$(sudo cat /run/secrets/cloudflare_account_id)"
```

`sops` is the source of truth; `terraform/cloudflare/terraform.tfvars` is gitignored (`terraform/**/*.tfvars`) and not used.

## Apply

```bash
tofu -chdir=terraform/cloudflare init -upgrade  # pins cloudflare ~>5.0 (5.24.0)
tofu -chdir=terraform/cloudflare plan            # 0 add / 0 destroy expected; 1 moved (record rename) or 0-1 in-place
tofu -chdir=terraform/cloudflare apply
dig cache.mippbipp.com +short                     # 129.146.202.171 (modules/globals.nix)
curl -fsS https://cache.mippbipp.com/fleet/nix-cache-info
```

## Why these values remain explicit

- `mippbipp.com` `type=full` — fresh domain, single zone, DNS hosted with Cloudflare.
- `cache` `A 129.146.202.171` — Oracle reserved IP for pewter; must stay in sync with `modules/globals.nix` `luksHostname` and `hosts/pewter/attic.nix` `allowed-hosts`. The Cloudflare provider cannot read Nix module values, so no codegen is used (ADR-0011).
- `ttl=300` — 5 min propagation; was `1` (auto) before tofu.
- `proxied=false` — DNS-only so `nginx` can complete Let's Encrypt HTTP-01 (`hosts/pewter/attic.nix`); proxied would hide the origin and break `attic` TLS. Future subdomains may use `proxied=true`.
