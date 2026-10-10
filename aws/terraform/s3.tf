# The server's one bucket (decision B14): roster CSV uploads and rejected-row exports
# under agency-ingest/, and the abandon clips. The server reads it as S3_AUDIO_BUCKET.

data "aws_caller_identity" "current" {}

locals {
  bucket_name = coalesce(
    var.bucket_name,
    "${var.name_prefix}-${var.environment}-${data.aws_caller_identity.current.account_id}",
  )
}

resource "aws_s3_bucket" "media" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy

  lifecycle {
    # Each environment has its own state, kept per workspace. Applying staging's
    # variables to dev's state would rename (destroy and recreate) dev's bucket.
    precondition {
      condition     = terraform.workspace == var.environment
      error_message = "Selected workspace \"${terraform.workspace}\" does not match environment \"${var.environment}\". Run `terraform workspace select ${var.environment}` (or `terraform workspace new ${var.environment}`) first."
    }
  }
}

# Objects belong to the bucket owner and ACLs are off; access is by IAM policy only.
resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Contact lists are PII. Nothing in the product reads the bucket from a browser:
# the server uploads and streams every object itself.
resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "media" {
  count  = var.noncurrent_version_expiration_days > 0 ? 1 : 0
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # The SDK's PutObject is a single request, but a client killed mid-upload can
  # still leave parts behind if multipart is ever used; they are billed until aborted.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = var.noncurrent_version_expiration_days > 0 ? [1] : []
    content {
      id     = "expire-noncurrent-versions"
      status = "Enabled"
      filter {}

      noncurrent_version_expiration {
        noncurrent_days = var.noncurrent_version_expiration_days
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.media]
}

# Refuse plain-HTTP requests. The SDK always uses TLS; this stops anything else.
data "aws_iam_policy_document" "media_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*",
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

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_tls_only.json

  # A bucket policy is refused while the public-access block is still being set.
  depends_on = [aws_s3_bucket_public_access_block.media]
}
