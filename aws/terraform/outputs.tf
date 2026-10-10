output "bucket_name" {
  description = "The server's S3_AUDIO_BUCKET."
  value       = aws_s3_bucket.media.bucket
}

output "region" {
  description = "The server's AWS_REGION."
  value       = var.region
}

output "server_iam_user" {
  description = "IAM user the server's access key belongs to."
  value       = aws_iam_user.server.name
}

output "server_access_key_id" {
  description = "The server's AWS_ACCESS_KEY_ID (null when create_access_key is false)."
  value       = var.create_access_key ? aws_iam_access_key.server[0].id : null
}

output "server_secret_access_key" {
  description = "The server's AWS_SECRET_ACCESS_KEY. Read it with `terraform output -raw server_secret_access_key`."
  value       = var.create_access_key ? aws_iam_access_key.server[0].secret : null
  sensitive   = true
}

# The four lines for apps/server/.env (or docker/.env), ready to append:
#   terraform output -raw server_env >> ../../apps/server/.env
output "server_env" {
  description = "S3 settings for the server's .env, including the secret."
  sensitive   = true
  value = join("\n", compact([
    "S3_AUDIO_BUCKET=${aws_s3_bucket.media.bucket}",
    "AWS_REGION=${var.region}",
    var.create_access_key ? "AWS_ACCESS_KEY_ID=${aws_iam_access_key.server[0].id}" : "",
    var.create_access_key ? "AWS_SECRET_ACCESS_KEY=${aws_iam_access_key.server[0].secret}" : "",
  ]))
}
