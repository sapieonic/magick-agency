# reports.tf against a mocked AWS provider: nothing here talks to AWS, needs credentials or
# writes state outside the test. Pins that an environment without enable_reports plans no
# reports resource and no change to the lifecycle rules or the server's policy, that the
# inputs reports needs are refused when missing, and the settings the renderer depends on.
#
#   cd aws/terraform && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::magick-agency-dev-x-123456789012" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:ap-south-1:123456789012:q", url = "https://sqs.ap-south-1.amazonaws.com/123456789012/q" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-south-1:123456789012:log-group:/aws/lambda/x" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { version = "4", arn = "arn:aws:lambda:ap-south-1:123456789012:function:x" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/magick-agency/x" }
  }
  mock_resource "aws_lambda_alias" {
    defaults = { arn = "arn:aws:lambda:ap-south-1:123456789012:function:x:live" }
  }
}

variables {
  environment = "default"
}

run "off_by_default" {
  command = plan
  assert {
    condition     = length(aws_sqs_queue.report_jobs) == 0 && length(aws_lambda_function.report_renderer) == 0 && length(aws_lambda_event_source_mapping.report_jobs) == 0 && length(aws_iam_role.report_renderer) == 0 && length(aws_cloudwatch_log_group.report_renderer) == 0
    error_message = "reports resources planned while disabled"
  }
  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.media.rule) == 1
    error_message = "lifecycle rules changed while disabled"
  }
  assert {
    condition     = length(data.aws_iam_policy_document.server_s3.statement) == 2
    error_message = "server policy changed while disabled"
  }
  assert {
    condition     = output.reports_server_env == "" && output.report_jobs_queue_url == null
    error_message = "reports outputs set while disabled"
  }
}

run "missing_inputs_refused" {
  command = plan
  variables {
    enable_reports = true
  }
  expect_failures = [aws_lambda_function.report_renderer]
}

run "short_secret_refused" {
  command = plan
  variables {
    reports_callback_secret = "short"
  }
  expect_failures = [var.reports_callback_secret]
}

run "quote_in_secret_refused" {
  command = plan
  variables {
    reports_callback_secret = "0123456789abcdef'0123456789abcdef0123"
  }
  expect_failures = [var.reports_callback_secret]
}

run "padded_secret_refused" {
  command = plan
  variables {
    reports_callback_secret = " 0123456789abcdef0123456789abcdef0123"
  }
  expect_failures = [var.reports_callback_secret]
}

run "enabled" {
  command = apply
  variables {
    enable_reports                     = true
    report_renderer_zip                = "versions.tf" # any file: the plan only hashes it
    report_renderer_chromium_layer_arn = "arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"
    reports_callback_secret            = "0123456789abcdef+/=$#\"0123456789abcdef0123"
    noncurrent_version_expiration_days = 30
  }
  assert {
    condition     = output.reports_server_env == "AGENCY_REPORTS_RENDERER=sqs\nAGENCY_REPORTS_SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/123456789012/q\nAGENCY_REPORTS_CALLBACK_SECRET='0123456789abcdef+/=$#\"0123456789abcdef0123'\nAGENCY_REPORTS_RENDER_TIMEOUT_MS=900000"
    error_message = "reports_server_env lines"
  }
  assert {
    condition     = aws_sqs_queue.report_jobs[0].visibility_timeout_seconds == 600 && aws_sqs_queue.report_jobs[0].message_retention_seconds == 86400 && aws_sqs_queue.report_jobs[0].sqs_managed_sse_enabled
    error_message = "queue settings"
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.report_jobs[0].redrive_policy).maxReceiveCount == 3 && aws_sqs_queue.report_jobs_dlq[0].message_retention_seconds == 1209600
    error_message = "redrive"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].runtime == "nodejs22.x" && aws_lambda_function.report_renderer[0].memory_size == 2048 && aws_lambda_function.report_renderer[0].timeout == 300 && aws_lambda_function.report_renderer[0].ephemeral_storage[0].size == 1024 && aws_lambda_function.report_renderer[0].publish && aws_lambda_function.report_renderer[0].handler == "index.handler" && length(aws_lambda_function.report_renderer[0].vpc_config) == 0
    error_message = "function settings"
  }
  assert {
    condition     = aws_lambda_alias.report_renderer_live[0].function_version == "4" && aws_lambda_alias.report_renderer_live[0].name == "live"
    error_message = "alias follows the published version"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.report_jobs[0].batch_size == 1 && aws_lambda_event_source_mapping.report_jobs[0].scaling_config[0].maximum_concurrency == 3 && aws_lambda_event_source_mapping.report_jobs[0].function_name == "arn:aws:lambda:ap-south-1:123456789012:function:x:live"
    error_message = "mapping"
  }
  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.media.rule) == 4
    error_message = "lifecycle rules"
  }
  assert {
    condition     = length(data.aws_iam_policy_document.server_s3.statement) == 3
    error_message = "server sqs statement"
  }
  assert {
    condition     = toset(flatten([for s in data.aws_iam_policy_document.report_renderer[0].statement : s.actions])) == toset(["logs:CreateLogStream", "logs:PutLogEvents", "s3:GetObject", "s3:PutObject", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"])
    error_message = "renderer actions"
  }
}

# The server's render timeout must outlast a redelivery: visibility (600 s) + function (300 s).
run "render_timeout_below_redelivery_refused" {
  command = plan
  variables {
    enable_reports                     = true
    report_renderer_zip                = "versions.tf"
    report_renderer_chromium_layer_arn = "arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"
    reports_callback_secret            = "0123456789abcdef0123456789abcdef0123"
    reports_render_timeout_seconds     = 899
  }
  expect_failures = [aws_sqs_queue.report_jobs]
}

run "render_timeout_raised" {
  command = apply
  variables {
    enable_reports                     = true
    report_renderer_zip                = "versions.tf"
    report_renderer_chromium_layer_arn = "arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"
    reports_callback_secret            = "0123456789abcdef0123456789abcdef0123"
    reports_render_timeout_seconds     = 1800
  }
  assert {
    condition     = endswith(output.reports_server_env, "\nAGENCY_REPORTS_RENDER_TIMEOUT_MS=1800000")
    error_message = "render timeout line"
  }
}

run "rollback_pins_alias" {
  command = apply
  variables {
    enable_reports                     = true
    report_renderer_zip                = "versions.tf" # any file: the plan only hashes it
    report_renderer_chromium_layer_arn = "arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"
    reports_callback_secret            = "0123456789abcdef0123456789abcdef0123"
    report_renderer_live_version       = "2"
  }
  assert {
    condition     = aws_lambda_alias.report_renderer_live[0].function_version == "2"
    error_message = "rollback version"
  }
}
