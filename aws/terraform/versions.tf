terraform {
  required_version = ">= 1.5.0"

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
