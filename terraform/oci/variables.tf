variable "tenancy_ocid" {
  description = "OCI tenancy OCID, supplied through SOPS and TF_VAR_tenancy_ocid"
  type        = string
  sensitive   = true
}

variable "user_ocid" {
  description = "OCI API user OCID, supplied through SOPS and TF_VAR_user_ocid"
  type        = string
  sensitive   = true
}

variable "fingerprint" {
  description = "OCI API key fingerprint, supplied through SOPS and TF_VAR_fingerprint"
  type        = string
  sensitive   = true
}

variable "private_key_path" {
  description = "Path to the SOPS-decrypted OCI API private key"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "OCI region, supplied through SOPS and TF_VAR_region"
  type        = string
}

variable "budget_alert_email" {
  description = "OCI budget alert recipient, supplied through SOPS and TF_VAR_budget_alert_email"
  type        = string
  sensitive   = true
}
