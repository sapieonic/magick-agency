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
  description = "AWS region for the bucket. Must match the server's AWS_REGION."
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

variable "extra_tags" {
  type        = map(string)
  description = "Tags added to every resource, on top of Project, Environment, ManagedBy and Module."
  default     = {}
}
