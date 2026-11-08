# Reports (docs/reports.md): the SQS queue the server sends render jobs to, and the Lambda
# that renders them. Off unless `enable_reports` is true, so an environment that has not
# switched reports on plans no change. The bucket's lifecycle rules for the report prefixes
# are in s3.tf, the server's sqs:SendMessage in iam.tf.
#
#   server ──SendMessage──► report-jobs ──event source mapping──► report-renderer:live
#     │ writes report-datasets/…                                    │ reads report-datasets/…
#     │ presigns GETs of reports/… (5 min)                          │ writes reports/…
#     ◄───────────── signed POST /webhooks/reports/rendered ────────┘
#
# The renderer never touches the database (RP1): it runs outside any VPC, reads the dataset
# the server wrote, writes the files and calls the server back over its public URL. The
# callback URL travels in each message, so the function needs only the callback secret.
#
# The server switches to this path with, in its env (`terraform output -raw reports_server_env`
# prints the first three):
#   AGENCY_REPORTS_RENDERER=sqs
#   AGENCY_REPORTS_SQS_QUEUE_URL=<report_jobs_queue_url>
#   AGENCY_REPORTS_CALLBACK_SECRET=<the same reports_callback_secret as the function>
#   AGENCY_REPORTS_CALLBACK_BASE_URL=<the server's public base URL, set by hand>
# Deploy order and rollback: aws/README.md, "Reports".

locals {
  report_renderer_name = "${var.name_prefix}-${var.environment}-report-renderer"
  report_jobs_name     = "${var.name_prefix}-${var.environment}-report-jobs"

  # Lambda's timeout, and the queue's visibility timeout at six times it (AWS's guidance
  # for an SQS event source: a message must stay invisible through the function's retries
  # of a batch, or a second invocation renders it while the first still runs).
  report_renderer_timeout_seconds = 300
  report_jobs_visibility_seconds  = 6 * local.report_renderer_timeout_seconds

  # RP8: datasets are an intermediate the renderer reads within minutes; 7 days leaves room
  # to re-render (RP13 re-sends) and to read one when a run is being diagnosed.
  report_dataset_retention_days = 7
}

# ── Queue and dead-letter queue ───────────────────────────────────────────────────────
# A message is one run's render attempt (ReportRenderMessage). Retention of a day is far
# past anything useful: the server re-sends a run with no callback after
# AGENCY_REPORTS_RENDER_TIMEOUT_MS (15 min) as a new attempt, and fences the old one's
# callback (RP13). Three receives without a delete (the function threw, timed out or ran out
# of memory three times) move it to the dead-letter queue, kept 14 days for diagnosis.
# Nothing replays the DLQ automatically; the server's re-send is the retry.

resource "aws_sqs_queue" "report_jobs_dlq" {
  count = var.enable_reports ? 1 : 0
  name  = "${local.report_jobs_name}-dlq"

  message_retention_seconds = 14 * 24 * 3600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "report_jobs" {
  count = var.enable_reports ? 1 : 0
  name  = local.report_jobs_name

  visibility_timeout_seconds = local.report_jobs_visibility_seconds
  message_retention_seconds  = 24 * 3600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.report_jobs_dlq[0].arn
    maxReceiveCount     = 3
  })
}

# Only report-jobs may dead-letter into the DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "report_jobs_dlq" {
  count     = var.enable_reports ? 1 : 0
  queue_url = aws_sqs_queue.report_jobs_dlq[0].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.report_jobs[0].arn]
  })
}

# ── The renderer's role ───────────────────────────────────────────────────────────────
# Exactly what the function does: write its own logs, read datasets, write report files,
# and (through the event source mapping, which runs as this role) receive and delete its
# queue's messages. No ListBucket, no delete, no access to the rest of the bucket (the
# contact lists under agency-ingest/), no database, no VPC.

data "aws_iam_policy_document" "report_renderer_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "report_renderer" {
  count              = var.enable_reports ? 1 : 0
  name               = local.report_renderer_name
  path               = "/${var.name_prefix}/"
  assume_role_policy = data.aws_iam_policy_document.report_renderer_assume.json
}

data "aws_iam_policy_document" "report_renderer" {
  count = var.enable_reports ? 1 : 0

  # The log group is created here (below), so the function needs no logs:CreateLogGroup.
  statement {
    sid       = "OwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.report_renderer[0].arn}:*"]
  }

  statement {
    sid       = "ReadDatasets"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/report-datasets/*"]
  }

  statement {
    sid       = "WriteReports"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.media.arn}/reports/*"]
  }

  statement {
    sid       = "ConsumeReportJobs"
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.report_jobs[0].arn]
  }
}

resource "aws_iam_role_policy" "report_renderer" {
  count  = var.enable_reports ? 1 : 0
  name   = "report-renderer"
  role   = aws_iam_role.report_renderer[0].id
  policy = data.aws_iam_policy_document.report_renderer[0].json
}

# ── The function ──────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "report_renderer" {
  count             = var.enable_reports ? 1 : 0
  name              = "/aws/lambda/${local.report_renderer_name}"
  retention_in_days = var.report_renderer_log_retention_days
}

# The zip is `pnpm --filter @magick-agency/report-renderer build:lambda`'s output
# (apps/report-renderer/dist/report-renderer-lambda.zip: the bundle dist/lambda/index.mjs at
# the zip's root). Headless Chromium comes from a layer (@sparticuz/chromium), never from the
# zip. Every apply with a new zip (source_code_hash) or a new configuration publishes a new
# version; the `live` alias, which the queue invokes, moves to it in the same apply unless
# report_renderer_live_version pins an older one (rollback, aws/README.md).
#
# 2048 MB: Chromium's renderer and a large workbook's streaming writer share it, and Lambda
# scales CPU with memory. 1024 MB of /tmp: Chromium unpacks its binary there at a cold start,
# and the detail sheets stream through it. No NODE_OPTIONS: the bundle needs no flag, and the heap
# limit follows the memory size.
resource "aws_lambda_function" "report_renderer" {
  count         = var.enable_reports ? 1 : 0
  function_name = local.report_renderer_name
  role          = aws_iam_role.report_renderer[0].arn

  filename         = var.report_renderer_zip
  source_code_hash = var.report_renderer_zip == null ? null : filebase64sha256(var.report_renderer_zip)
  runtime          = "nodejs22.x"
  handler          = var.report_renderer_handler
  architectures    = ["x86_64"]
  layers           = compact([var.report_renderer_chromium_layer_arn])

  memory_size = 2048
  timeout     = local.report_renderer_timeout_seconds
  ephemeral_storage {
    size = 1024
  }

  publish = true

  environment {
    variables = {
      # Signs the callback (docs/reports.md, "Contracts"); the server holds the same value.
      AGENCY_REPORTS_CALLBACK_SECRET = var.reports_callback_secret
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.report_renderer,
    aws_iam_role_policy.report_renderer,
  ]

  lifecycle {
    precondition {
      condition     = var.report_renderer_zip != null && var.report_renderer_chromium_layer_arn != null && var.reports_callback_secret != null
      error_message = "enable_reports needs report_renderer_zip, report_renderer_chromium_layer_arn and reports_callback_secret (aws/README.md, \"Reports\")."
    }
  }
}

# The queue invokes the alias, never $LATEST, so a rollback is repointing `live` at an older
# published version: set report_renderer_live_version and apply (or `aws lambda update-alias`,
# which the next apply undoes unless the variable is set too).
resource "aws_lambda_alias" "report_renderer_live" {
  count            = var.enable_reports ? 1 : 0
  name             = "live"
  description      = "The version the report-jobs queue invokes. Roll back by pointing it at an older version."
  function_name    = aws_lambda_function.report_renderer[0].function_name
  function_version = coalesce(var.report_renderer_live_version, aws_lambda_function.report_renderer[0].version)
}

# One message per invocation, so a failure is that run's alone; the handler answers
# ReportBatchItemFailures, so a message it could not finish goes back to the queue (and
# after three receives to the DLQ) without failing anything else. At most 3 renders at once:
# each holds a Chromium, and a burst of scheduled runs waits in the queue instead.
resource "aws_lambda_event_source_mapping" "report_jobs" {
  count            = var.enable_reports ? 1 : 0
  event_source_arn = aws_sqs_queue.report_jobs[0].arn
  function_name    = aws_lambda_alias.report_renderer_live[0].arn

  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 3
  }

  # The mapping is validated against the role's queue permissions when it is created.
  depends_on = [aws_iam_role_policy.report_renderer]
}
