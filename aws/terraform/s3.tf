# The server's one bucket (decision B14): roster CSV uploads and rejected-row exports
# under agency-ingest/, and the abandon clips. With enable_reports, also the report datasets
# under report-datasets/ and the rendered reports under reports/ (reports.tf). The server
# reads it as S3_AUDIO_BUCKET.

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

# Contact lists are PII, and so are reports. The server uploads and streams every object
# itself, with one deliberate exception (reports design review): a report download is a
# presigned GET of one object under reports/, valid 5 minutes, that the console navigates
# to after the server has checked the caller may read that run. A presigned GET is a signed
# request by the server's own identity, so the bucket stays fully private: no public
# access, no bucket-policy grant, and no CORS (the browser navigates, it does not fetch).
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

  # Reports (RP8): datasets 7 days, rendered files report_retention_days (the run turns
  # `expired` at the same age on the server). S3 removes an object at the first midnight UTC
  # after it reaches that age, so a file lasts as long as its run, up to a day longer.
  # With versioning on, an expired object becomes a noncurrent version; these rules drop it
  # after 1 day instead of the bucket-wide noncurrent_version_expiration_days (S3 honours
  # the shorter of two overlapping expirations): a report or dataset is derived data that
  # the retention promise covers, not an upload worth keeping to undo an overwrite.
  dynamic "rule" {
    for_each = var.enable_reports ? {
      "expire-report-datasets" = { prefix = "report-datasets/", days = local.report_dataset_retention_days }
      "expire-reports"         = { prefix = "reports/", days = var.report_retention_days }
    } : {}
    content {
      id     = rule.key
      status = "Enabled"

      filter {
        prefix = rule.value.prefix
      }

      expiration {
        days = rule.value.days
      }

      dynamic "noncurrent_version_expiration" {
        for_each = var.noncurrent_version_expiration_days > 0 ? [1] : []
        content {
          noncurrent_days = 1
        }
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
