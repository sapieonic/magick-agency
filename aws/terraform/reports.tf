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
# Nothing is prepared by hand: at plan time the module builds the renderer's zip from this
# checkout (scripts/build-report-renderer.mjs) and fetches the Chromium layer zip the renderer
# pins, checksum checked (scripts/fetch-chromium-layer.mjs); it generates the callback secret and
# keeps it in SSM. `report_renderer_zip` and `report_renderer_chromium_layer_arn` override the first two.
#
# The server switches to this path with, in its env:
#   AGENCY_REPORTS_RENDERER=sqs                       ┐
#   AGENCY_REPORTS_SQS_QUEUE_URL=<report_jobs_queue_url>  │ terraform output -raw reports_server_env
#   AGENCY_REPORTS_RENDER_TIMEOUT_MS=<reports_render_timeout_seconds × 1000> ┘
#   AGENCY_REPORTS_CALLBACK_SECRET=<from SSM>         ← sh -c "$(terraform output -raw reports_callback_secret_env_command)"
#   AGENCY_REPORTS_CALLBACK_BASE_URL=<the server's public base URL, set by hand>
# Deploy order, rollback and rotating the secret: aws/README.md, "Reports".

locals {
  report_renderer_name = "${var.name_prefix}-${var.environment}-report-renderer"
  report_jobs_name     = "${var.name_prefix}-${var.environment}-report-jobs"

  # The three timeouts of a render attempt, and the order they must keep (the queue's
  # precondition below checks it against reports_render_timeout_seconds):
  #
  #   function timeout (300 s) < visibility timeout (600 s)
  #   visibility timeout + function timeout (900 s) <= the server's render timeout (900 s default)
  #
  # The first is AWS's (an event source mapping refuses a queue whose visibility timeout is
  # below the function's timeout, which would let a second invocation take the message while
  # the first still runs). The second makes SQS's redelivery of a record the function failed
  # (an undeliverable callback, a crash, a timeout) land, and finish, while the server is
  # still waiting for that attempt; a redelivery after the server's render timeout, when the
  # tick has re-sent the run as the next attempt or failed it, could only end `stale`. The
  # function drops such a message without rendering (it carries `superseded_after`, the
  # server's deadline for the attempt), so a later redelivery costs an invocation of
  # milliseconds, not a second Chromium render. Hence a visibility timeout of twice
  # the function's, not AWS's suggested six times: the margin it buys is for invocations
  # throttled at the account's concurrency limit, and a message that outlasts its receives
  # under throttling is re-sent by the server (RP13) anyway.
  report_renderer_timeout_seconds = 300
  report_jobs_visibility_seconds  = 2 * local.report_renderer_timeout_seconds

  # RP8: datasets are an intermediate the renderer reads within minutes; 7 days leaves room
  # to re-render (RP13 re-sends) and to read one when a run is being diagnosed.
  report_dataset_retention_days = 7

  # ── Chromium layer ──
  # The renderer's pin: the @sparticuz/chromium version and its x64 layer zip's SHA-256, kept
  # beside the dependency it must match (the renderer's test/chromium-layer.test.ts fails a bump
  # of one without the other). Paths under path.module stay relative, so the state records the
  # same ones from any clone, machine or worktree.
  chromium_layer         = jsondecode(file("${path.module}/../../apps/report-renderer/chromium-layer.json"))
  chromium_layer_zip     = "${path.module}/.artifacts/chromium-v${local.chromium_layer.version}-layer.x64.zip"
  publish_chromium_layer = var.enable_reports && var.report_renderer_chromium_layer_arn == null
  chromium_layer_arn     = local.publish_chromium_layer ? one(aws_lambda_layer_version.chromium[*].arn) : var.report_renderer_chromium_layer_arn

  # ── Renderer zip ──
  build_renderer_zip = var.enable_reports && var.report_renderer_zip == null
  built_renderer_zip = "${path.module}/../../apps/report-renderer/dist/report-renderer-lambda.zip"

  # ── Callback secret ──
  # One secret per generation, keyed by it: the current one and the one before. Raising the
  # generation from g to g + 1 makes g + 1's, keeps g's and drops g - 1's, which is what lets a
  # rotation overlap (aws/README.md, "Rotating the callback secret"): the server holds both while
  # the Lambda moves from g to g + 1.
  callback_secret_generation         = var.reports_callback_secret_generation
  callback_secret_generations        = toset([tostring(max(local.callback_secret_generation - 1, 1)), tostring(local.callback_secret_generation)])
  callback_secret_signing_generation = var.reports_callback_secret_sign_with_previous ? local.callback_secret_generation - 1 : local.callback_secret_generation
  # The server's env key → its SSM parameter and generation; the previous one from the first rotation on.
  callback_secret_parameters = merge(
    { AGENCY_REPORTS_CALLBACK_SECRET = { name = "callback-secret", generation = local.callback_secret_generation } },
    local.callback_secret_generation > 1 ? { AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS = { name = "callback-secret-previous", generation = local.callback_secret_generation - 1 } } : {},
  )
}

# ── Queue and dead-letter queue ───────────────────────────────────────────────────────
# A message is one run's render attempt (ReportRenderMessage). Retention of a day is far
# past anything useful: the server re-sends a run with no callback after
# AGENCY_REPORTS_RENDER_TIMEOUT_MS (15 min) as a new attempt, and fences the old one's
# callback (RP13). Three receives without a delete (the function threw, timed out, ran out
# of memory or could not deliver its callback, three times) move it to the dead-letter queue,
# kept 14 days for diagnosis. With the message received promptly, its first redelivery
# (600 s after that receive) finishes inside the server's wait for the attempt; the third
# receive, 1200 s or more after it, is past that wait and is dropped unrendered
# (`superseded_after`). Nothing replays the DLQ automatically; the server's
# re-send is the retry.

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

  lifecycle {
    precondition {
      condition     = local.report_jobs_visibility_seconds > local.report_renderer_timeout_seconds && local.report_jobs_visibility_seconds + local.report_renderer_timeout_seconds <= var.reports_render_timeout_seconds
      error_message = "reports_render_timeout_seconds must be at least the queue's visibility timeout plus the function's timeout (${local.report_jobs_visibility_seconds + local.report_renderer_timeout_seconds} s), so a redelivered render finishes while the server still waits for it (reports.tf, locals)."
    }
  }
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

# ── The callback secret ───────────────────────────────────────────────────────────────
# AGENCY_REPORTS_CALLBACK_SECRET: the HMAC key the renderer signs its callback with and the
# server verifies it with. 48 letters and digits: past the server's 32-character minimum, with no
# quote, space or `$` for a .env file or a shell to trip over. It is kept in SSM as a SecureString
# under the account's aws/ssm key, and in this module's state (like the server's access key). The
# apply puts the same value in the function's environment (an edit made in SSM by hand reaches
# neither the function nor the next apply, which puts the state's value back); the
# server's copy is read from SSM (`reports_callback_secret_env_command`). No output prints it.

resource "random_password" "reports_callback" {
  for_each = var.enable_reports ? local.callback_secret_generations : []

  length  = 48
  special = false
}

# callback-secret is the current generation; callback-secret-previous, from the first rotation
# on, the one before, for the server's AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS during a rotation.
resource "aws_ssm_parameter" "reports_callback_secret" {
  for_each    = var.enable_reports ? local.callback_secret_parameters : {}
  name        = "/${var.name_prefix}/${var.environment}/reports/${each.value.name}"
  description = "${each.key}, generation ${each.value.generation} (aws/terraform, reports.tf)."
  type        = "SecureString"
  value       = random_password.reports_callback[tostring(each.value.generation)].result
}

# ── The Chromium layer ────────────────────────────────────────────────────────────────
# @sparticuz/chromium's x86_64 layer zip (about 72 MB, over Lambda's 50 MB direct upload) is
# fetched at plan time, checked against the renderer's chromium-layer.json, put in the bucket under
# lambda-artifacts/ and published from there. A layer version never changes once published, so a
# Chromium bump is a new object key, a new layer version and a new function version. Function
# versions published against an older layer version keep it (Lambda holds a deleted layer
# version for the functions that use it), so a rollback with report_renderer_live_version still
# gets the Chromium it was built for.

# The program answers the zip's verified hash, base64; using it (not the path, fixed above) is
# what orders the upload after the fetch.
data "external" "chromium_layer" {
  count   = local.publish_chromium_layer ? 1 : 0
  program = ["node", "${path.module}/scripts/fetch-chromium-layer.mjs"]
  query = {
    version = local.chromium_layer.version
    sha256  = local.chromium_layer.sha256
    path    = local.chromium_layer_zip
  }
}

resource "aws_s3_object" "chromium_layer" {
  count        = local.publish_chromium_layer ? 1 : 0
  bucket       = aws_s3_bucket.media.id
  key          = "lambda-artifacts/chromium-v${local.chromium_layer.version}-layer.x64.zip"
  source       = local.chromium_layer_zip
  source_hash  = data.external.chromium_layer[0].result.sha256_base64
  content_type = "application/zip"
}

resource "aws_lambda_layer_version" "chromium" {
  count       = local.publish_chromium_layer ? 1 : 0
  layer_name  = "${var.name_prefix}-${var.environment}-chromium"
  description = "@sparticuz/chromium ${local.chromium_layer.version} (x86_64) for the report renderer"

  s3_bucket        = aws_s3_object.chromium_layer[0].bucket
  s3_key           = aws_s3_object.chromium_layer[0].key
  source_code_hash = data.external.chromium_layer[0].result.sha256_base64

  compatible_runtimes      = ["nodejs22.x"]
  compatible_architectures = ["x86_64"]
}

# ── The renderer zip ──────────────────────────────────────────────────────────────────
# Built from this checkout at every plan, unless report_renderer_zip names a prebuilt one. The
# build is reproducible, so source_code_hash below (the program's answer: the zip's hash, base64)
# changes only when the bundle does, and only then does an apply publish a new version.

data "external" "report_renderer_zip" {
  count   = local.build_renderer_zip ? 1 : 0
  program = ["node", "${path.module}/scripts/build-report-renderer.mjs"]
  query = {
    repo_root = "${path.module}/../.."
    zip       = local.built_renderer_zip
  }
}

# ── The function ──────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "report_renderer" {
  count             = var.enable_reports ? 1 : 0
  name              = "/aws/lambda/${local.report_renderer_name}"
  retention_in_days = var.report_renderer_log_retention_days
}

# The zip is `pnpm --filter @magick-agency/report-renderer build:lambda`'s output
# (apps/report-renderer/dist/report-renderer-lambda.zip: the bundle dist/lambda/index.mjs at
# the zip's root). Headless Chromium comes from the layer above, never from the zip. Every
# apply with a new zip (source_code_hash), a new layer or a new configuration (a rotated secret)
# publishes a new version; the `live` alias, which the queue invokes, moves to it in the same
# apply unless report_renderer_live_version pins an older one (rollback, aws/README.md).
#
# 2048 MB: Chromium's renderer and a large workbook's streaming writer share it, and Lambda
# scales CPU with memory. 1024 MB of /tmp: Chromium unpacks its binary there at a cold start,
# and the detail sheets stream through it. No NODE_OPTIONS: the bundle needs no flag, and the heap
# limit follows the memory size.
resource "aws_lambda_function" "report_renderer" {
  count         = var.enable_reports ? 1 : 0
  function_name = local.report_renderer_name
  role          = aws_iam_role.report_renderer[0].arn

  filename         = local.build_renderer_zip ? local.built_renderer_zip : var.report_renderer_zip
  source_code_hash = local.build_renderer_zip ? data.external.report_renderer_zip[0].result.sha256_base64 : filebase64sha256(var.report_renderer_zip)
  runtime          = "nodejs22.x"
  handler          = var.report_renderer_handler
  architectures    = ["x86_64"]
  layers           = [local.chromium_layer_arn]

  memory_size = 2048
  timeout     = local.report_renderer_timeout_seconds
  ephemeral_storage {
    size = 1024
  }

  publish = true

  environment {
    variables = {
      # Signs the callback (docs/reports.md, "Contracts"): the current generation, or the one
      # before while a rotation has reports_callback_secret_sign_with_previous set.
      AGENCY_REPORTS_CALLBACK_SECRET = random_password.reports_callback[tostring(local.callback_secret_signing_generation)].result
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.report_renderer,
    aws_iam_role_policy.report_renderer,
  ]

  lifecycle {
    precondition {
      condition     = !var.reports_callback_secret_sign_with_previous || local.callback_secret_generation > 1
      error_message = "reports_callback_secret_sign_with_previous needs reports_callback_secret_generation 2 or more: before the first rotation there is no previous secret (aws/README.md, \"Rotating the callback secret\")."
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
