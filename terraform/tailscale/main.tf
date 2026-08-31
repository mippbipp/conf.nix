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
        attr   = ["nextdns:7b9721", "nextdns:no-device-info"] # profile 7b9721 via DoH + hide device names
      },
    ]
  })
}

# Tailnet DNS — NextDNS globals (ADR-0005/0006/0012). Profile 7b9721 via DoH (443/TCP) — sentinel is profile-linked IPv6.
# Tailscale maps the sentinel + nodeAttrs nextdns:7b9721 to DoH https://dns.nextdns.io/7b9721; plaintext 45.90.28.0 is blocked everywhere.
resource "tailscale_dns_configuration" "global" {
  magic_dns          = true
  override_local_dns = true
  nameservers {
    address            = "2a07:a8c0::7b:9721" # NextDNS profile 7b9721 linked IPv6
    use_with_exit_node = true
  }
}
