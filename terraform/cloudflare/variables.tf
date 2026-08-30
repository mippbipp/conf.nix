variable "cloudflare_account_id" {
  description = "Cloudflare account ID for mippbipp.com (dashboard URL); sops: cloudflare_account_id"
  type        = string
  sensitive   = true
}
