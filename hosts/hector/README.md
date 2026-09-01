# hector — work EC2 NixOS dev machine

`aarch64-linux` Graviton `m7g.medium` `80 GB gp3` `us-east-1`, tailnet-only after bootstrap. `disko` on `/dev/nvme0n1` → `512M ESP /boot` + `btrfs @/@home/@nix`. Isolated `terraform/aws-hector/` local state. See `docs/adr/0015-hector-work-ec2-dev-machine.md`.

## AWS setup steps

### 1. Creds + TF vars

```bash
export AWS_PROFILE=work  # SSO; tofu inherits it
aws sts get-caller-identity
export TF_VAR_owner=$(aws sts get-caller-identity --query Arn --output text | rev | cut -d/ -f1 | rev)
export TF_VAR_project=hector
export TF_VAR_aws_region=us-east-1
# optional: TF_VAR_vpc_id / TF_VAR_subnet_id — else default VPC first subnet (terraform/aws-hector/main.tf:44)
```

**Done when** `aws sts get-caller-identity` shows work account and `TF_VAR_owner` matches `Owner` on existing `hector` resources.

### 2. Provision

```bash
tofu -chdir=terraform/aws-hector init -upgrade
tofu -chdir=terraform/aws-hector plan
tofu -chdir=terraform/aws-hector apply
tofu -chdir=terraform/aws-hector output # instance_id, public_ip, sg_id
```

**Done when** `tofu output` shows `m7g.medium` `80 GB` `sg_id`.

### 3. Temp SSH ingress (for `nixos-anywhere` only)

- Allow current host to SSH into `hector` via `22`
```bash
export MYIP=$(curl ip.me); echo $MYIP
aws ec2 authorize-security-group-ingress --group-id $(tofu -chdir=terraform/aws-hector output -raw sg_id) \
  --protocol tcp --port 22 --cidr $MYIP/32
```

**Done when** `aws ec2 describe-security-groups --group-ids $(tofu -chdir=terraform/aws-hector output -raw sg_id)` shows your `/32` on `22`.

### 4. Extra-files (tailscale auth)

```bash
mkdir -p /tmp/hector-extra-files/var/lib/tailscale
echo "tskey-auth-..." > /tmp/hector-extra-files/var/lib/tailscale/authkey; chmod 600 $_
```

**Done when** `authkey` is `600` under `/tmp/hector-extra-files`.

### 5. Install

```bash
export PIP=$(tofu -chdir=terraform/aws-hector output -raw public_ip); echo $PIP
```

- EC2 launches Ubuntu 24.04 without `key_name`; Ubuntu disables `root` password login, `nixos-anywhere` has no key to `ssh-copy-id`.
- **Fix:** inject `globals.hosts.<current_host>.pubkey` via SSM (`AmazonSSMManagedInstanceCore` on `aws_iam_role.hector`):
  ```bash
  aws ssm start-session --target $(tofu -chdir=terraform/aws-hector output -raw instance_id)
  sudo mkdir -p /root/.ssh; echo "<pubkey>" | sudo tee -a /root/.ssh/authorized_keys
  sudo mkdir -p /home/ubuntu/.ssh; sudo cat /root/.ssh/authorized_keys | sudo tee -a /home/ubuntu/.ssh/authorized_keys
  sudo chmod 700 /root/.ssh /home/ubuntu/.ssh; sudo chmod 600 /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
  sudo chown -R root:root /root/.ssh; sudo chown -R ubuntu:ubuntu /home/ubuntu/.ssh
  ```
  Verify `ssh root@$PIP whoami` before re-running `nixos-anywhere`.

```bash
nix run github:nix-community/nixos-anywhere -- \
  --flake .#hector \
  --extra-files /tmp/hector-extra-files \
  --kexec-extra-flags "-c" \
  root@$PIP
```

**Done when** `ssh hector` (or `hector.<tailnet>.ts.net`) and `ssh hector -- nixos-rebuild --help` succeed; `tailscale status | grep hector` shows host (warpe split-DNS `~ts.net`, gram MagicDNS).

### 6. Close + day-2

```bash
# rm 22
aws ec2 revoke-security-group-ingress --group-id $(tofu -chdir=terraform/aws-hector output -raw sg_id) \
  --protocol tcp --port 22 --cidr $MYIP/32
# add 22
aws ec2 authorize-security-group-ingress --group-id $(tofu -chdir=terraform/aws-hector output -raw sg_id) \
  --protocol tcp --port 22 --cidr $MYIP/32

# stop:
aws ec2 stop-instances --instance-ids $(tofu -chdir=terraform/aws-hector output -raw instance_id)

# start:
aws ec2 start-instances --instance-ids $(tofu -chdir=$HOME/conf.nix/terraform/aws-hector output -raw instance_id)
aws ec2 wait instance-running --instance-ids $(tofu -chdir=$HOME/conf.nix/terraform/aws-hector output -raw instance_id)
aws ec2 describe-instances --instance-ids $(tofu -chdir=$HOME/conf.nix/terraform/aws-hector output -raw instance_id) --query 'Reservations[0].Instances[0].State.Name'

# increase storage size if needed:
aws ec2 modify-volume --volume-id vol-xxx --size 120 && ssh hector -- sudo btrfs filesystem resize max /

# add hector to current machine's ssh:
nrs

# build hector
nrs --push hector
```

**Done when** SG has no `22` ingress, `stop` keeps volume, `btrfs resize` reflects new size.

## Reference

- **Cost:** `m7g.medium $0.0408/h` (`$29.78/mo` 24/7, `~$7.2/mo` 8h×22d + `~$6.4/mo` 80 GB gp3). `terraform/aws-hector/main.tf:194` is source for type/size.
- **IAM:** least-priv profile (`AmazonSSMManagedInstanceCore` + `eks:Describe/*` + `eks:Create/Delete` on `Owner` tag + `ec2:Describe*` + `iam:Get/List` + `ssm:StartSession` + `iam:PassRole` → `eks.amazonaws.com`), not `AdministratorAccess`. Source `terraform/aws-hector/main.tf:119`.
- **Verify host:** `nix flake check; nix build ".#nixosConfigurations.hector.config.system.build.toplevel"` (`docs/agents/adding-a-host.md:55`).

