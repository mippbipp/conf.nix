terraform {
  required_version = ">= 1.6" # floor for import blocks; aligns with terraform/tailscale
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN from sops -> /run/secrets (modules/system/config/sops.nix)

resource "cloudflare_zone" "mippbipp" {
  account = {
    id = var.cloudflare_account_id # sops: cloudflare_account_id, never committed
  }
  name = "mippbipp.com" # sole zone owned by tofu as Control plane (ADR-0011); imported, not created
  type = "full"         # full = DNS hosted with Cloudflare
}

variable "pewter_ip" {
  description = "Pewter public IP; must stay in sync with modules/globals.nix luksHostname and Oracle reserved IP"
  type        = string
  default     = "129.146.202.171" # Oracle reserved IP for pewter
}

moved {
  from = cloudflare_record.cache
  to   = cloudflare_dns_record.cache
}

resource "cloudflare_dns_record" "cache" {
  # DNS-only so pewter nginx can complete Let's Encrypt HTTP-01 (proxied would hide origin and break hosts/pewter/attic.nix enableACME).
  # 300s TTL balances propagation vs cache.
  zone_id = cloudflare_zone.mippbipp.id
  name    = "cache"
  content = var.pewter_ip
  type    = "A"
  ttl     = 300
  proxied = false
  comment = "pewter attic - managed by tofu (ADR-0011)"
}
