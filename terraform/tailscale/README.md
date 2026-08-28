# terraform/tailscale

Source of truth for tailnet policy file + DNS. Nix owns devices.

## 1. Create OAuth client

`https://login.tailscale.com/admin/settings/oauth` -> Generate client with scopes `Devices:Write, ACL:Write, DNS:Write, Auth Keys:Write`. Save `client_id` + `client_secret`.

## 2. Add secrets (sops)

```bash
SOPS_AGE_KEY_FILE=/var/lib/sops-nix/keys.txt sudo -E sops secrets.yaml
# add:
tailscale_tailnet: your-tailnet.ts.net
tailscale_oauth_client_id: ENC[...]
tailscale_oauth_client_secret: ENC[...]
```

`sops.nix` already exposes them as `/run/secrets/tailscale_*` (`modules/system/config/sops.nix:22`).

## 4. Init + import existing tailnet

```bash
export TAILSCALE_TAILNET="$(cat /run/secrets/tailscale_tailnet)"
export TAILSCALE_OAUTH_CLIENT_ID="$(cat /run/secrets/tailscale_oauth_client_id)"
export TAILSCALE_OAUTH_CLIENT_SECRET="$(cat /run/secrets/tailscale_oauth_client_secret)"

tofu -chdir=terraform/tailscale init
tofu -chdir=terraform/tailscale import tailscale_acl.main acl
tofu -chdir=terraform/tailscale import tailscale_dns_configuration.global dns_configuration
tofu -chdir=terraform/tailscale plan
tofu -chdir=terraform/tailscale apply
```

After `apply`, `https://login.tailscale.com/admin/machines` -> `pewter` -> approve `tag:opencode-connector` if prompted, `Disable key expiry`.

## 5. Verify

```bash
# check routes
tailscale appc-routes
curl -v https://api.opencode.ai
```

Add domains in `main.tf:nodeAttrs` `domains` then `tofu apply`. Do not edit in console — overwritten.
