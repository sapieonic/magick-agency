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

# ── Server VM (null when create_server is false) ─────────────────────────────────────

output "server_public_ip" {
  description = "The Elastic IP: the DNS A record's value, and the address to give VoiceLink if it allow-lists API callers."
  value       = one(aws_eip.server[*].public_ip)
}

output "server_instance_id" {
  description = "EC2 instance id, for Session Manager (`aws ssm start-session --target <id>`)."
  value       = one(aws_instance.server[*].id)
}

output "server_private_ip" {
  description = "The instance's private IP: CONSOLE_BIND for the load-balancer variant (DEPLOYMENT.md, section 10)."
  value       = one(aws_instance.server[*].private_ip)
}

output "server_security_group_id" {
  description = "The VM's security group. Allow TCP 5432 from it on the database's security group."
  value       = one(aws_security_group.server[*].id)
}

output "server_availability_zone" {
  description = "The instance's AZ. Put the RDS instance in the same AZ (or Multi-AZ) to keep latency and cross-AZ traffic down."
  value       = one(aws_instance.server[*].availability_zone)
}
