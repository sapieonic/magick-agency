# The server's identity for S3. `apps/server/src/storage/s3.ts` builds its client from
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY only (no role or instance profile), so the
# server gets an IAM user with an access key.

resource "aws_iam_user" "server" {
  name = "${var.name_prefix}-${var.environment}-server"
  path = "/${var.name_prefix}/"
}

# Only what the server calls: PutObject (uploadFile), GetObject (getFile,
# getFileStream, presigned GETs; it also authorises HeadObject for headFile) and
# ListBucket, without which a missing object reads as 403 instead of 404. No
# delete: nothing calls deleteFile or deleteByPrefix today. Add s3:DeleteObject
# here when something does.
data "aws_iam_policy_document" "server_s3" {
  statement {
    sid       = "ObjectReadWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "ListForNotFound"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_user_policy" "server_s3" {
  name   = "s3-media"
  user   = aws_iam_user.server.name
  policy = data.aws_iam_policy_document.server_s3.json
}

resource "aws_iam_access_key" "server" {
  count = var.create_access_key ? 1 : 0
  user  = aws_iam_user.server.name
}
