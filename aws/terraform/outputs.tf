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

# ── Reports (null when enable_reports is false) ──────────────────────────────────────

output "report_jobs_queue_url" {
  description = "The server's AGENCY_REPORTS_SQS_QUEUE_URL."
  value       = one(aws_sqs_queue.report_jobs[*].url)
}

output "report_jobs_dlq_url" {
  description = "The report-jobs dead-letter queue: messages the renderer failed three times. Its depth is in CloudWatch (ApproximateNumberOfMessagesVisible)."
  value       = one(aws_sqs_queue.report_jobs_dlq[*].url)
}

output "report_renderer_function_name" {
  description = "The renderer Lambda's name, for its logs (/aws/lambda/<name>) and `aws lambda update-alias`."
  value       = one(aws_lambda_function.report_renderer[*].function_name)
}

output "report_renderer_alias_arn" {
  description = "ARN of the `live` alias the queue invokes."
  value       = one(aws_lambda_alias.report_renderer_live[*].arn)
}

output "report_renderer_live_version" {
  description = "The published version `live` points at now."
  value       = one(aws_lambda_alias.report_renderer_live[*].function_version)
}

# The reports lines for the server's env, ready to append like server_env. The fourth,
# AGENCY_REPORTS_CALLBACK_BASE_URL (the server's public base URL), is set by hand. The secret is
# single-quoted so dotenv and Docker Compose read `$`, `#` and `"` literally; a single quote has
# no escape inside single quotes, so var.reports_callback_secret refuses one (variables.tf), and
# refuses leading or trailing whitespace, which the server refuses too.
output "reports_server_env" {
  description = "Reports settings for the server's .env, including the callback secret (empty when enable_reports is false)."
  sensitive   = true
  value = var.enable_reports ? join("\n", [
    "AGENCY_REPORTS_RENDERER=sqs",
    "AGENCY_REPORTS_SQS_QUEUE_URL=${aws_sqs_queue.report_jobs[0].url}",
    "AGENCY_REPORTS_CALLBACK_SECRET='${var.reports_callback_secret == null ? "" : var.reports_callback_secret}'",
    "AGENCY_REPORTS_RENDER_TIMEOUT_MS=${var.reports_render_timeout_seconds * 1000}",
  ]) : ""
}
