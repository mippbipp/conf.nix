# terraform/aws-hector

Isolated local state for `hector`'s work-AWS resources — separate from `terraform/oci/` (`docs/adr/0015-hector-work-ec2-dev-machine.md`). Tailnet-only; `terraform/aws-hector/main.tf` is source for type/size/tags/policy — this file is only the credential + init pointer.

## Steps

```bash
aws sso login --profile work; export AWS_PROFILE=work
export TF_VAR_owner=<work-username> TF_VAR_project=hector TF_VAR_aws_region=us-east-1  # Owner=your session name, not sso role
tofu -chdir=terraform/aws-hector init -upgrade
tofu -chdir=terraform/aws-hector plan  # 7 to add: m7g.medium 80 GB gp3
```

**Done when** `plan` shows 7 to add and `tofu output` gives `instance_id`/`public_ip`/`sg_id`. State stays local, gitignored (`.gitignore:4`); commit only `.terraform.lock.hcl`.
