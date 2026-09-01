terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_region" {
  description = "Work AWS region"
  type        = string
  default     = "us-east-1"
}

variable "owner" {
  description = "Owner tag"
  type        = string
}

variable "project" {
  description = "Project tag"
  type        = string
  default     = "hector"
}

variable "vpc_id" {
  description = "Work dev VPC ID (default: default VPC)"
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "Subnet (default: first private subnet in VPC)"
  type        = string
  default     = null
}

provider "aws" {
  region = var.aws_region
}

data "aws_vpc" "selected" {
  id = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
}

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "selected" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.selected.id]
  }
}

# Ubuntu 24.04 Noble arm64 via SSM (Graviton) — resolves to ami-xxx for m7g.medium
data "aws_ssm_parameter" "ubuntu_noble_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# SG: tailnet-only after bootstrap. Temp 22 ingress added manually for nixos-anywhere then removed.
resource "aws_security_group" "hector" {
  name        = "hector-${var.owner}"
  description = "hector dev box - tailnet-only, no public 22 after bootstrap"
  vpc_id      = data.aws_vpc.selected.id
  tags = {
    Name    = "hector-${var.owner}"
    Owner   = var.owner
    Project = var.project
  }

  # outbound all (Nix fetch, Tailscale DERP)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # no ingress — tailnet is overlay on top of outbound; add 22/tcp temp via console/CLI only for install
  # ingress {
  #   description = "temp nixos-anywhere"
  #   from_port   = 22
  #   to_port     = 22
  #   protocol    = "tcp"
  #   cidr_blocks = ["<warpe-egress-ip>/32"]
  # }

  lifecycle {
    prevent_destroy = false # set true after import per ADR 0015
  }
}

data "aws_iam_policy" "ssm_core" {
  arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role" "hector" {
  name = "hector-${var.owner}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
  tags = {
    Name    = "hector-${var.owner}"
    Owner   = var.owner
    Project = var.project
  }
}

resource "aws_iam_policy" "hector_least_priv" {
  name        = "hector-least-priv-${var.owner}"
  description = "Least-privilege for hector: EKS cluster mgmt + EC2/ IAM describe + SSM (no AdministratorAccess)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EKSDescribe"
        Effect   = "Allow"
        Action   = ["eks:DescribeCluster", "eks:ListClusters", "eks:DescribeUpdate", "eks:ListUpdates"]
        Resource = "*"
      },
      {
        Sid      = "EKSManageScoped"
        Effect   = "Allow"
        Action   = ["eks:CreateCluster", "eks:DeleteCluster", "eks:UpdateClusterConfig", "eks:TagResource", "eks:UntagResource"]
        Resource = "arn:aws:eks:${var.aws_region}:*:cluster/*"
        Condition = {
          StringEquals = { "aws:ResourceTag/Owner" = var.owner }
        }
      },
      {
        Sid      = "EC2Describe"
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ec2:DescribeInstanceTypes", "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeIamInstanceProfileAssociations", "ec2:DescribeVolumes"]
        Resource = "*"
      },
      {
        Sid      = "IAMDescribe"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:GetInstanceProfile", "iam:ListInstanceProfiles", "iam:GetPolicy", "iam:ListRoles", "iam:ListPolicyVersions"]
        Resource = "*"
      },
      {
        Sid      = "SSMSession"
        Effect   = "Allow"
        Action   = ["ssm:StartSession", "ssm:DescribeInstanceInformation", "ssm:DescribeSessions", "ssmmessages:*", "ec2messages:*"]
        Resource = "*"
      },
      {
        Sid      = "PassRoleToEKS"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = "arn:aws:iam::*:role/*"
        Condition = {
          StringEquals = { "iam:PassedToService" = "eks.amazonaws.com" }
        }
      }
    ]
  })
  tags = {
    Owner   = var.owner
    Project = var.project
  }
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.hector.name
  policy_arn = data.aws_iam_policy.ssm_core.arn
}

resource "aws_iam_role_policy_attachment" "least_priv" {
  role       = aws_iam_role.hector.name
  policy_arn = aws_iam_policy.hector_least_priv.arn
}

resource "aws_iam_instance_profile" "hector" {
  name = "hector-${var.owner}"
  role = aws_iam_role.hector.name
  tags = {
    Owner   = var.owner
    Project = var.project
  }
}

resource "aws_instance" "hector" {
  ami                    = data.aws_ssm_parameter.ubuntu_noble_arm64.value
  instance_type          = "m7g.medium"
  subnet_id              = var.subnet_id != null ? var.subnet_id : data.aws_subnets.selected.ids[0]
  vpc_security_group_ids = [aws_security_group.hector.id]
  iam_instance_profile   = aws_iam_instance_profile.hector.name
  ebs_optimized          = true

  root_block_device {
    volume_size           = 80
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
    tags = {
      Name    = "hector-${var.owner}-root"
      Owner   = var.owner
      Project = var.project
    }
  }

  # ephemeral public IP only for nixos-anywhere bootstrap; toggle false after tailnet up
  associate_public_ip_address = true

  tags = {
    Name    = "hector-${var.owner}"
    Owner   = var.owner
    Project = var.project
  }

  lifecycle {
    ignore_changes = [ami] # NixOS owns the guest OS after nixos-anywhere (like terraform/oci/main.tf:228)
    prevent_destroy = false
  }
}

output "instance_id" { value = aws_instance.hector.id }
output "private_ip" { value = aws_instance.hector.private_ip }
output "public_ip" { value = aws_instance.hector.public_ip }
output "sg_id" { value = aws_security_group.hector.id }
output "profile" { value = aws_iam_instance_profile.hector.name }
