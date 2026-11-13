# The S3 bucket that holds aws/terraform's and grafana/terraform's state (each under its own
# key), so any machine with AWS access can plan and apply (aws/README.md, "State"). Applied
# once per AWS account, before either module's first `terraform init`. Its own state is local (gitignored) and holds no secret: it only matters for
# changing this bucket later, and a lost copy is recovered with `terraform import`.
#
# The bucket name is also in aws/terraform/versions.tf and grafana/terraform/versions.tf (a
# backend block cannot read variables): change all three together.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "bucket_name" {
  type        = string
  description = "Name of the state bucket. Must equal `bucket` in aws/terraform/versions.tf and grafana/terraform/versions.tf."
  default     = "magick-agency-terraform-state"
}

variable "region" {
  type        = string
  description = "Region of the state bucket. Must equal `region` in both modules' versions.tf."
  default     = "ap-south-1"
}

variable "aws_profile" {
  type        = string
  description = "Optional named profile from ~/.aws/config. Null uses the default credential chain."
  default     = null
}

variable "noncurrent_version_expiration_days" {
  type        = number
  description = "How long a replaced state version is kept, for recovering from a bad apply."
  default     = 90
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "magick-agency"
      ManagedBy = "terraform"
      Module    = "aws/state"
    }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.bucket_name

  # Every environment's state lives here; destroying it orphans all of them.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The state holds the server's secret access key and the reports callback secret.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Every write keeps the previous state as a version: the way back from a bad apply or a
# corrupted state.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket     = aws_s3_bucket.state.id
  depends_on = [aws_s3_bucket_versioning.state]

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
    # Each lock (`*.tflock`) leaves a delete marker behind; drop it once nothing is under it.
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "state_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = data.aws_iam_policy_document.state_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "bucket" {
  value = aws_s3_bucket.state.id
}

output "region" {
  value = var.region
}
