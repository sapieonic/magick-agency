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
  description = "The VM's security group."
  value       = one(aws_security_group.server[*].id)
}

output "server_availability_zone" {
  description = "The instance's availability zone."
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

# The reports lines for the server's env that are not secret, ready to append like server_env,
# and a comment line saying where the secret comes from (dotenv and Compose skip `#` lines).
# AGENCY_REPORTS_CALLBACK_BASE_URL (the server's public base URL) is set by hand.
output "reports_server_env" {
  description = "Reports settings for the server's .env, without the callback secret: a comment line says how to read it from SSM (empty when enable_reports is false)."
  value = var.enable_reports ? join("\n", [
    "AGENCY_REPORTS_RENDERER=sqs",
    "AGENCY_REPORTS_SQS_QUEUE_URL=${aws_sqs_queue.report_jobs[0].url}",
    "AGENCY_REPORTS_RENDER_TIMEOUT_MS=${var.reports_render_timeout_seconds * 1000}",
    "# AGENCY_REPORTS_CALLBACK_SECRET is in SSM (${local.reports_ssm_names["AGENCY_REPORTS_CALLBACK_SECRET"]}): sh -c \"$(terraform output -raw reports_callback_secret_env_command)\" prints its line",
  ]) : ""
}

output "reports_callback_secret_parameter" {
  description = "SSM parameter (SecureString) holding AGENCY_REPORTS_CALLBACK_SECRET, the current generation."
  value       = lookup(local.reports_ssm_names, "AGENCY_REPORTS_CALLBACK_SECRET", null)
}

output "reports_callback_secret_previous_parameter" {
  description = "SSM parameter holding the generation before, for AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS during a rotation (null before the first rotation)."
  value       = lookup(local.reports_ssm_names, "AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS", null)
}

# Which secret the function signs with, without printing it: compare with the server's
# `printf %s "$AGENCY_REPORTS_CALLBACK_SECRET" | sha256sum` when callbacks are refused.
output "reports_callback_secret_signing_sha256" {
  description = "SHA-256 (hex) of the callback secret the function signs with (null when enable_reports is false)."
  value       = var.enable_reports ? nonsensitive(sha256(aws_lambda_function.report_renderer[0].environment[0].variables.AGENCY_REPORTS_CALLBACK_SECRET)) : null
}

# A shell command that reads the secret from SSM and prints its .env line, single-quoted (the
# generated value is letters and digits, so nothing inside needs escaping). Run it where you apply
# (it needs the AWS CLI and ssm:GetParameter), then put its line(s) in the server's env IN PLACE of
# any existing ones: dotenv takes the last copy of a key.
#   sh -c "$(terraform output -raw reports_callback_secret_env_command)"
# While a rotation has the Lambda signing with the old generation it prints a second line,
# AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS, so the server accepts both (aws/README.md, "Rotating
# the callback secret"). A failed or empty read prints nothing and exits 1, never an empty line.
output "reports_callback_secret_env_command" {
  description = "Shell command that prints the server's AGENCY_REPORTS_CALLBACK_SECRET line (and, mid-rotation, AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS) from SSM (empty when enable_reports is false)."
  value = join("\n", [
    for key, name in local.reports_ssm_names :
    "v=$(aws ssm get-parameter --region ${var.region}${var.aws_profile == null ? "" : " --profile ${var.aws_profile}"} --name ${name} --with-decryption --query Parameter.Value --output text) && [ -n \"$v\" ] && printf \"${key}='%s'\\n\" \"$v\" || { echo 'could not read ${name} from SSM' >&2; exit 1; }"
    if key == "AGENCY_REPORTS_CALLBACK_SECRET" || var.reports_callback_secret_sign_with_previous
  ])
}

locals {
  # The server's env key → the SSM parameter holding it (empty when enable_reports is false).
  reports_ssm_names = { for key, p in aws_ssm_parameter.reports_callback_secret : key => p.name }
}
