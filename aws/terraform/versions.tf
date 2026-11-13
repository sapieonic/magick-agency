terraform {
  # 1.10 for the S3 backend's lock file (use_lockfile).
  required_version = ">= 1.10.0"

  # State lives in S3, so any machine with AWS access can plan and apply (aws/README.md,
  # "State"). The bucket is made once per account by aws/state; its name and region are repeated
  # there (a backend block cannot read variables). The default workspace's state is at `key`,
  # every other workspace's at `env:/<workspace>/<key>`. The backend authenticates with the
  # usual AWS chain, not the provider's `aws_profile`: export AWS_PROFILE, or pass
  # `-backend-config="profile=<name>"` to `terraform init`.
  backend "s3" {
    bucket       = "magick-agency-terraform-state"
    key          = "aws/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # reports.tf: the plan-time renderer build and Chromium layer fetch (scripts/), and the
    # generated callback secret. Neither talks to AWS; both run on the machine that applies.
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Credentials come from the usual AWS chain (AWS_PROFILE, AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY, SSO), so no secret lands in version control. `aws_profile`
# is only a convenience for picking a named profile per environment.
provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = merge(
      {
        Project     = var.name_prefix
        Environment = var.environment
        ManagedBy   = "terraform"
        Module      = "aws/terraform"
      },
      var.extra_tags,
    )
  }
}
