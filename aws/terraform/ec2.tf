# The VM that runs docker/docker-compose.prod.yml (DEPLOYMENT.md, section 3.2): one EC2
# instance, its security group and an Elastic IP. Off unless `create_server` is true, so
# an environment that only needs the bucket (a developer's dev-<name>) gets no VM.
#
# One instance, always (deployment invariant 1): the agency runtime assumes one server
# process. Postgres is not here; it is a managed database the server reaches over TLS.

locals {
  server_name = "${var.name_prefix}-${var.environment}-server"

  # Canonical's image paths say amd64 / arm64; EC2 says x86_64 / arm64.
  server_arch = var.create_server ? (
    contains(data.aws_ec2_instance_type.server[0].supported_architectures, "arm64") ? "arm64" : "amd64"
  ) : null

  server_subnet_id = var.create_server ? try(coalesce(var.subnet_id, sort(data.aws_subnets.default[0].ids)[0]), null) : null
}

data "aws_ec2_instance_type" "server" {
  count         = var.create_server ? 1 : 0
  instance_type = var.instance_type
}

# Ubuntu 26.04 LTS (Resolute Raccoon) for the instance type's architecture (t4g.* is
# arm64; the server image builds for either). Canonical publishes the current AMI id
# under AWS's public /aws/service/canonical parameters, so no name pattern or owner
# filter is needed. `insecure_value`: a public AMI id, not a secret.
data "aws_ssm_parameter" "ubuntu_ami" {
  count = var.create_server && var.ami_id == null ? 1 : 0
  name  = "/aws/service/canonical/ubuntu/server/26.04/stable/current/${local.server_arch}/hvm/ebs-gp3/ami-id"
}

# The default VPC and one of its default subnets, unless `subnet_id` names one. Sorted
# so the same subnet is picked on every plan.
data "aws_vpc" "default" {
  count   = var.create_server && var.subnet_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.create_server && var.subnet_id == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_subnet" "server" {
  count = var.create_server ? 1 : 0
  id    = local.server_subnet_id

  lifecycle {
    precondition {
      condition     = local.server_subnet_id != null
      error_message = "The region has no default VPC subnet. Set subnet_id to a public subnet."
    }
  }
}

# ── Security group ────────────────────────────────────────────────────────────────────
# 80 and 443 for the TLS terminator on the host (Caddy: 80 for Let's Encrypt and the
# http→https redirect). 22 only from `ssh_cidrs` and, with `enable_instance_connect`,
# from AWS's EC2 Instance Connect range. Never 8080, 8081 or 3021: nginx and the
# super-admin UI are bound to loopback, and the server publishes no port.

resource "aws_security_group" "server" {
  count       = var.create_server ? 1 : 0
  name        = local.server_name
  description = "Magick Agency server VM: HTTPS in, SSH from allow-listed addresses"
  vpc_id      = data.aws_subnet.server[0].vpc_id

  tags = { Name = local.server_name }
}

resource "aws_vpc_security_group_ingress_rule" "server_web" {
  for_each          = var.create_server ? { http = 80, https = 443 } : {}
  security_group_id = aws_security_group.server[0].id
  description       = each.key
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "server_ssh" {
  for_each          = var.create_server ? toset(var.ssh_cidrs) : toset([])
  security_group_id = aws_security_group.server[0].id
  description       = "ssh"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

# EC2 Instance Connect: SSH from the browser console. The console's SSH session comes
# from AWS's own range for the region, published as a managed prefix list, so port 22
# opens to that service only, never to the internet.
data "aws_ec2_managed_prefix_list" "instance_connect" {
  count = var.create_server && var.enable_instance_connect ? 1 : 0
  name  = "com.amazonaws.${var.region}.ec2-instance-connect"
}

resource "aws_vpc_security_group_ingress_rule" "server_instance_connect" {
  count             = var.create_server && var.enable_instance_connect ? 1 : 0
  security_group_id = aws_security_group.server[0].id
  description       = "ssh from EC2 Instance Connect"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  prefix_list_id    = data.aws_ec2_managed_prefix_list.instance_connect[0].id
}

# The server calls VoiceLink, Firebase, Mailjet, S3, the AI APIs and Postgres.
resource "aws_vpc_security_group_egress_rule" "server_all" {
  count             = var.create_server ? 1 : 0
  security_group_id = aws_security_group.server[0].id
  description       = "all outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ── Instance role: Session Manager only ──────────────────────────────────────────────
# Lets you open a shell or the super-admin tunnel through SSM without opening port 22.
# It grants no S3 access: the server reads S3 credentials from its env only (iam.tf).

data "aws_iam_policy_document" "server_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "server_instance" {
  count              = var.create_server && var.enable_ssm ? 1 : 0
  name               = "${local.server_name}-instance"
  path               = "/${var.name_prefix}/"
  assume_role_policy = data.aws_iam_policy_document.server_assume.json
}

resource "aws_iam_role_policy_attachment" "server_ssm" {
  count      = var.create_server && var.enable_ssm ? 1 : 0
  role       = aws_iam_role.server_instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "server" {
  count = var.create_server && var.enable_ssm ? 1 : 0
  name  = "${local.server_name}-instance"
  path  = "/${var.name_prefix}/"
  role  = aws_iam_role.server_instance[0].name
}

# ── Instance ──────────────────────────────────────────────────────────────────────────

resource "aws_key_pair" "server" {
  count      = var.create_server && var.ssh_public_key != null ? 1 : 0
  key_name   = local.server_name
  public_key = var.ssh_public_key
}

resource "aws_instance" "server" {
  count                  = var.create_server ? 1 : 0
  ami                    = coalesce(var.ami_id, try(data.aws_ssm_parameter.ubuntu_ami[0].insecure_value, null))
  instance_type          = var.instance_type
  subnet_id              = local.server_subnet_id
  vpc_security_group_ids = [aws_security_group.server[0].id]
  key_name               = var.ssh_public_key != null ? aws_key_pair.server[0].key_name : var.key_name
  iam_instance_profile   = var.enable_ssm ? aws_iam_instance_profile.server[0].name : null

  # Docker, Caddy, git and a swap file. The repo, docker/.env and the Caddyfile are
  # still set up by hand (DEPLOYMENT.md, sections 5 to 7).
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    swap_bytes = var.swap_gb * 1024 * 1024 * 1024
  })

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
    tags        = { Name = local.server_name }
  }

  # IMDSv2 only. Hop limit 1 keeps the instance credentials out of reach of the
  # containers, which have no use for them.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = { Name = local.server_name }

  lifecycle {
    # A newer Ubuntu AMI or an edited cloud-init must not replace a running server: that
    # hangs up live calls and drops Redis's call tokens. Replace it deliberately with
    # `terraform apply -replace='aws_instance.server[0]'`.
    ignore_changes = [ami, user_data]

    precondition {
      condition     = var.ssh_public_key == null || var.key_name == null
      error_message = "Set ssh_public_key (a new key pair) or key_name (an existing one), not both."
    }
  }
}

# ── Elastic IP ────────────────────────────────────────────────────────────────────────
# The address the DNS record points at and the one vendors see calls come from
# (VoiceLink may allow-list it). Associated separately so it outlives the instance:
# replacing the VM re-associates the same address.

resource "aws_eip" "server" {
  count  = var.create_server ? 1 : 0
  domain = "vpc"

  tags = { Name = local.server_name }
}

resource "aws_eip_association" "server" {
  count         = var.create_server ? 1 : 0
  allocation_id = aws_eip.server[0].id
  instance_id   = aws_instance.server[0].id
}
