terraform {
  required_version = ">= 1.6"
  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.21"
    }
  }
}

# Credentials via env (sops -> /run/secrets): TAILSCALE_TAILNET, TAILSCALE_OAUTH_CLIENT_ID/SECRET or TAILSCALE_API_KEY
provider "tailscale" {}

# Tailnet policy file — source of truth. Console edits are overwritten on next apply.
# Import existing policy first: tofu import tailscale_acl.main acl
resource "tailscale_acl" "main" {
  acl = jsonencode({
    # Legacy ACLs — prefer grants below; kept for compat (allow members to reach each other)
    acls = [
      { action = "accept", src = ["autogroup:member"], dst = ["autogroup:member:*"] },
    ]

    grants = [
      # Allow exit-node / internet egress
      { src = ["autogroup:member"], dst = ["autogroup:internet"], ip = ["*"] },
    ]

    ssh = [
      {
        action = "check"
        src    = ["autogroup:member"]
        dst    = ["autogroup:self"]
        users  = ["autogroup:nonroot", "root"]
      },
    ]

    nodeAttrs = [
      {
        target = ["*"]
        attr   = ["nextdns:no-device-info"] # hide device names from NextDNS logs (optional)
      },
    ]
  })
}

# Tailnet DNS — NextDNS globals (ADR-0005/0006). API has no NextDNS ID field; ID 7b9721 expands to 4 IPs below.
resource "tailscale_dns_configuration" "global" {
  magic_dns          = true
  override_local_dns = true # force Globals over local resolvers
  # keep Globals when exit node selected
  nameservers {
    address            = "45.90.28.0"
    use_with_exit_node = true
  }
  nameservers {
    address            = "45.90.30.0"
    use_with_exit_node = true
  }
  nameservers {
    address            = "2a07:a8c0::"
    use_with_exit_node = true
  }
  nameservers {
    address            = "2a07:a8c1::"
    use_with_exit_node = true
  }
}
