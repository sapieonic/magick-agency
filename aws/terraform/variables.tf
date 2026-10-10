variable "environment" {
  type        = string
  description = "Environment name, e.g. dev-manas, staging, production. Part of every resource name, and must equal the selected Terraform workspace (each environment keeps its own state)."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$", var.environment))
    error_message = "environment must be 2-24 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}

variable "region" {
  type        = string
  description = "AWS region for the bucket (and the server VM, when create_server is true). Must match the server's AWS_REGION."
  default     = "ap-south-1"
}

variable "aws_profile" {
  type        = string
  description = "Named AWS CLI profile to apply with. Null uses the default credential chain (AWS_PROFILE, env keys, SSO)."
  default     = null
}

variable "name_prefix" {
  type        = string
  description = "Prefix of every resource name."
  default     = "magick-agency"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,20}$", var.name_prefix))
    error_message = "name_prefix must be 1-21 characters of lowercase letters, digits and hyphens."
  }
}

variable "bucket_name" {
  type        = string
  description = "Exact bucket name, overriding the default <name_prefix>-<environment>-<account id>. S3 names are global, so the default carries the account id to stay unique."
  default     = null
}

variable "force_destroy" {
  type        = bool
  description = "Let `terraform destroy` delete a bucket that still holds objects. Handy for a throwaway dev environment; leave false anywhere the data matters (uploaded contact lists, abandon clips)."
  default     = false
}

variable "create_access_key" {
  type        = bool
  description = "Create an access key for the server's IAM user. The server reads S3 credentials only from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, so it needs one. The secret is stored in this module's state, so keep the state private."
  default     = true
}

variable "noncurrent_version_expiration_days" {
  type        = number
  description = "Days a replaced or deleted object version is kept before S3 removes it. 0 leaves versioning off."
  default     = 0

  validation {
    condition     = var.noncurrent_version_expiration_days >= 0
    error_message = "noncurrent_version_expiration_days must be 0 (versioning off) or a positive number of days."
  }
}

# ── Server VM (ec2.tf) ────────────────────────────────────────────────────────────────

variable "create_server" {
  type        = bool
  description = "Create the EC2 instance that runs docker/docker-compose.prod.yml, its security group and an Elastic IP. Off by default, so a bucket-only environment gets no VM."
  default     = false
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type. Default 2 vCPU / 4 GB (t3.medium); with the image build on the box, the swap file (swap_gb) carries the peaks. t4g.medium (arm64, cheaper) works too; the AMI follows the type's architecture."
  default     = "t3.medium"
}

variable "root_volume_gb" {
  type        = number
  description = "Root volume size (gp3, encrypted). Docker images, build cache, container logs and the swap file live here; prune old images and build cache (`docker system prune`) to stay inside 20 GB."
  default     = 20

  validation {
    condition     = var.root_volume_gb >= 20
    error_message = "root_volume_gb must be at least 20: the image build alone needs several GB."
  }
}

variable "swap_gb" {
  type        = number
  description = "Swap file size made at first boot. 0 makes none. EC2 has no swap by default."
  default     = 2

  validation {
    condition     = var.swap_gb >= 0 && floor(var.swap_gb) == var.swap_gb
    error_message = "swap_gb must be a whole number, 0 or more."
  }
}

variable "ami_id" {
  type        = string
  description = "Exact AMI to launch. Null picks the latest Ubuntu 26.04 LTS for the instance type's architecture (looked up at the first apply only; later AMIs never replace the instance)."
  default     = null
}

variable "subnet_id" {
  type        = string
  description = "Public subnet for the instance. Null picks a default subnet of the default VPC."
  default     = null
}

variable "ssh_cidrs" {
  type        = list(string)
  description = "IPv4 CIDRs allowed to SSH in, e.g. [\"198.51.100.7/32\"]. Empty opens no SSH port; use Session Manager (enable_ssm) instead."
  default     = []

  validation {
    condition     = alltrue([for c in var.ssh_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0"])
    error_message = "ssh_cidrs must be valid IPv4 CIDRs, and not 0.0.0.0/0."
  }
}

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key to log in as `ubuntu` with; a key pair is created from it. Leave null to use key_name, or no key at all with Session Manager."
  default     = null
}

variable "key_name" {
  type        = string
  description = "Name of an existing EC2 key pair, instead of ssh_public_key."
  default     = null
}

variable "enable_instance_connect" {
  type        = bool
  description = "Open port 22 to AWS's EC2 Instance Connect range for the region, so the console's \"EC2 Instance Connect\" tab gives a browser SSH session. Needs no key pair: the console pushes a short-lived key."
  default     = false
}

variable "enable_ssm" {
  type        = bool
  description = "Give the instance a role with AmazonSSMManagedInstanceCore, for Session Manager shells and port forwarding (the super-admin tunnel) without an open SSH port."
  default     = true
}

variable "extra_tags" {
  type        = map(string)
  description = "Tags added to every resource, on top of Project, Environment, ManagedBy and Module."
  default     = {}
}
