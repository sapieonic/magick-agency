# reports.tf against a mocked AWS provider: nothing here talks to AWS, needs credentials or
# writes state outside the test. Pins that an environment without enable_reports plans no
# reports resource and no change to the lifecycle rules or the server's policy; that
# enable_reports alone is enough (the layer, the zip and the secret need no input); the
# overrides; the callback secret's generations through a rotation; and the settings the renderer
# depends on.
#
# The two plan-time programs (scripts/) are overridden, so the tests neither build the renderer
# nor download Chromium; the random provider is the real one (it runs locally).
#
#   cd aws/terraform && terraform init -backend=false && terraform test
#
# Runs share one state, in order: the rotation runs build on `enabled`.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::magick-agency-dev-x-123456789012", id = "magick-agency-dev-x-123456789012" }
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
  mock_resource "aws_lambda_layer_version" {
    defaults = { arn = "arn:aws:lambda:ap-south-1:123456789012:layer:magick-agency-default-chromium:1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/magick-agency/x" }
  }
  mock_resource "aws_lambda_alias" {
    defaults = { arn = "arn:aws:lambda:ap-south-1:123456789012:function:x:live" }
  }
}

mock_provider "external" {}

# What the programs answer: the built zip's hash, and the pinned layer checksum in base64.
override_data {
  target = data.external.report_renderer_zip
  values = { result = { sha256_base64 = "cmVuZGVyZXIgYnVpbGQ=" } }
}

override_data {
  target = data.external.chromium_layer
  values = { result = { sha256_base64 = "bvq9HBUxGWZ5qFM92Vl/B6Nz96e9bhqer4JGsKkHEBA=" } }
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
    condition     = length(aws_lambda_layer_version.chromium) == 0 && length(aws_s3_object.chromium_layer) == 0 && length(data.external.chromium_layer) == 0 && length(data.external.report_renderer_zip) == 0
    error_message = "layer fetched or zip built while disabled"
  }
  assert {
    condition     = length(random_password.reports_callback) == 0 && length(aws_ssm_parameter.reports_callback_secret) == 0
    error_message = "callback secret made while disabled"
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
    condition     = output.reports_server_env == "" && output.reports_callback_secret_env_command == "" && output.report_jobs_queue_url == null && output.reports_callback_secret_parameter == null
    error_message = "reports outputs set while disabled"
  }
}

# enable_reports and nothing else: no layer ARN, no zip, no secret.
run "enabled" {
  command = apply
  variables {
    enable_reports                     = true
    noncurrent_version_expiration_days = 30
  }

  # ── The Chromium layer: the renderer's pin, checksum checked, published from S3 ──
  assert {
    condition     = data.external.chromium_layer[0].query == tomap({ version = local.chromium_layer.version, sha256 = local.chromium_layer.sha256, path = "./.artifacts/chromium-v${local.chromium_layer.version}-layer.x64.zip" })
    error_message = "the fetch is not for the renderer's pin (apps/report-renderer/chromium-layer.json), at a relative path"
  }
  assert {
    condition     = aws_s3_object.chromium_layer[0].key == "lambda-artifacts/chromium-v${local.chromium_layer.version}-layer.x64.zip" && aws_s3_object.chromium_layer[0].source == data.external.chromium_layer[0].query.path && aws_s3_object.chromium_layer[0].source_hash == "bvq9HBUxGWZ5qFM92Vl/B6Nz96e9bhqer4JGsKkHEBA="
    error_message = "layer object"
  }
  assert {
    condition     = aws_lambda_layer_version.chromium[0].s3_key == aws_s3_object.chromium_layer[0].key && aws_lambda_layer_version.chromium[0].source_code_hash == "bvq9HBUxGWZ5qFM92Vl/B6Nz96e9bhqer4JGsKkHEBA=" && aws_lambda_layer_version.chromium[0].compatible_architectures == toset(["x86_64"]) && aws_lambda_layer_version.chromium[0].compatible_runtimes == toset(["nodejs22.x"]) && aws_lambda_layer_version.chromium[0].layer_name == "magick-agency-default-chromium"
    error_message = "layer version settings"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].layers == tolist(["arn:aws:lambda:ap-south-1:123456789012:layer:magick-agency-default-chromium:1"])
    error_message = "function uses the published layer"
  }

  # ── The zip: built from this checkout, the hash its bytes' ──
  assert {
    condition     = fileexists("${data.external.report_renderer_zip[0].query.repo_root}/apps/report-renderer/package.json")
    error_message = "the build runs at the repository root"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].filename == "./../../apps/report-renderer/dist/report-renderer-lambda.zip" && data.external.report_renderer_zip[0].query.zip == aws_lambda_function.report_renderer[0].filename && aws_lambda_function.report_renderer[0].source_code_hash == "cmVuZGVyZXIgYnVpbGQ="
    error_message = "function deploys the built zip (a relative path) with the build's hash"
  }

  # ── The secret: generated, in SSM, the function's, and in no output ──
  assert {
    condition     = keys(random_password.reports_callback) == ["1"] && random_password.reports_callback["1"].length == 48 && !random_password.reports_callback["1"].special
    error_message = "generation 1 only: 48 letters and digits"
  }
  assert {
    condition     = aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].type == "SecureString" && aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].name == "/magick-agency/default/reports/callback-secret" && aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value == random_password.reports_callback["1"].result
    error_message = "current secret parameter"
  }
  assert {
    condition     = keys(aws_ssm_parameter.reports_callback_secret) == ["AGENCY_REPORTS_CALLBACK_SECRET"] && output.reports_callback_secret_previous_parameter == null
    error_message = "no previous parameter before the first rotation"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].environment[0].variables.AGENCY_REPORTS_CALLBACK_SECRET == aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value && length(aws_lambda_function.report_renderer[0].environment[0].variables.AGENCY_REPORTS_CALLBACK_SECRET) == 48
    error_message = "function signs with the current secret"
  }
  assert {
    condition     = output.reports_server_env == "AGENCY_REPORTS_RENDERER=sqs\nAGENCY_REPORTS_SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/123456789012/q\nAGENCY_REPORTS_RENDER_TIMEOUT_MS=900000\n# AGENCY_REPORTS_CALLBACK_SECRET is in SSM (/magick-agency/default/reports/callback-secret): sh -c \"$(terraform output -raw reports_callback_secret_env_command)\" prints its line"
    error_message = "reports_server_env lines"
  }
  assert {
    condition     = output.reports_callback_secret_signing_sha256 == sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value)
    error_message = "signing fingerprint is the current secret's"
  }
  assert {
    condition     = !strcontains(output.reports_server_env, aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value) && !strcontains(output.reports_callback_secret_env_command, aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value)
    error_message = "an output prints the secret"
  }
  assert {
    condition     = output.reports_callback_secret_env_command == "v=$(aws ssm get-parameter --region ap-south-1 --name /magick-agency/default/reports/callback-secret --with-decryption --query Parameter.Value --output text) && [ -n \"$v\" ] && printf \"AGENCY_REPORTS_CALLBACK_SECRET='%s'\\n\" \"$v\" || { echo 'could not read /magick-agency/default/reports/callback-secret from SSM' >&2; exit 1; }"
    error_message = "secret env command"
  }

  # ── Unchanged settings ──
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

# ── Rotation (aws/README.md, "Rotating the callback secret") ──

# Step 1: generation 2 made, the function still signing with 1; the server takes both.
run "rotate_stage" {
  command = apply
  variables {
    enable_reports                             = true
    reports_callback_secret_generation         = 2
    reports_callback_secret_sign_with_previous = true
  }
  assert {
    condition     = keys(random_password.reports_callback) == ["1", "2"]
    error_message = "generation 2 made, generation 1 kept"
  }
  assert {
    condition     = aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value == random_password.reports_callback["2"].result && aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].value == random_password.reports_callback["1"].result && aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value != aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].value
    error_message = "current is generation 2, previous generation 1"
  }
  assert {
    condition     = aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].name == "/magick-agency/default/reports/callback-secret-previous" && aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].type == "SecureString"
    error_message = "previous parameter"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].environment[0].variables.AGENCY_REPORTS_CALLBACK_SECRET == aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].value
    error_message = "function still signs with generation 1"
  }
  assert {
    condition     = output.reports_callback_secret_signing_sha256 == run.enabled.reports_callback_secret_signing_sha256
    error_message = "the stage step changed the function's secret"
  }
  assert {
    condition     = length(split("\n", output.reports_callback_secret_env_command)) == 2 && strcontains(output.reports_callback_secret_env_command, "AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS='%s'") && strcontains(output.reports_callback_secret_env_command, "--name /magick-agency/default/reports/callback-secret-previous ")
    error_message = "env command prints both lines mid-rotation"
  }
}

# Step 2: the function moves to generation 2; the server already accepts it.
run "rotate_finish" {
  command = apply
  variables {
    enable_reports                     = true
    reports_callback_secret_generation = 2
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].environment[0].variables.AGENCY_REPORTS_CALLBACK_SECRET == aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value
    error_message = "function signs with generation 2"
  }
  assert {
    condition     = output.reports_callback_secret_signing_sha256 != run.enabled.reports_callback_secret_signing_sha256 && sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].value) == run.enabled.reports_callback_secret_signing_sha256
    error_message = "function moved off generation 1, which is now the previous parameter"
  }
  assert {
    condition     = length(split("\n", output.reports_callback_secret_env_command)) == 1
    error_message = "env command prints the current line only"
  }
}

# The next rotation: generation 3 made, generation 2 kept, generation 1 dropped.
run "rotate_again_stage" {
  command = apply
  variables {
    enable_reports                             = true
    reports_callback_secret_generation         = 3
    reports_callback_secret_sign_with_previous = true
  }
  assert {
    condition     = keys(random_password.reports_callback) == ["2", "3"]
    error_message = "generations 2 and 3 only"
  }
  assert {
    condition     = output.reports_callback_secret_signing_sha256 == run.rotate_finish.reports_callback_secret_signing_sha256 && sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS"].value) == run.rotate_finish.reports_callback_secret_signing_sha256
    error_message = "the function still signs with generation 2, now the previous parameter"
  }
  assert {
    condition     = sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value) != run.enabled.reports_callback_secret_signing_sha256 && sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value) != run.rotate_finish.reports_callback_secret_signing_sha256
    error_message = "generation 3 is a new secret, not generation 1 back"
  }
}

run "rotate_again_finish" {
  command = apply
  variables {
    enable_reports                     = true
    reports_callback_secret_generation = 3
  }
  assert {
    condition     = output.reports_callback_secret_signing_sha256 == sha256(aws_ssm_parameter.reports_callback_secret["AGENCY_REPORTS_CALLBACK_SECRET"].value) && output.reports_callback_secret_signing_sha256 != run.rotate_again_stage.reports_callback_secret_signing_sha256
    error_message = "function signs with generation 3"
  }
}

# Before the first rotation there is no previous secret to sign with.
run "sign_with_previous_before_a_rotation_refused" {
  command = plan
  variables {
    enable_reports                             = true
    reports_callback_secret_generation         = 1
    reports_callback_secret_sign_with_previous = true
  }
  expect_failures = [aws_lambda_function.report_renderer]
}

# ── Overrides: a prebuilt zip and an existing layer; nothing built, fetched or published ──
run "overrides" {
  command = plan
  variables {
    enable_reports                     = true
    report_renderer_zip                = "tests/fixtures/renderer.zip"
    report_renderer_chromium_layer_arn = "arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"
  }
  assert {
    condition     = length(data.external.report_renderer_zip) == 0 && length(data.external.chromium_layer) == 0 && length(aws_s3_object.chromium_layer) == 0 && length(aws_lambda_layer_version.chromium) == 0
    error_message = "built, fetched or published despite the overrides"
  }
  assert {
    condition     = aws_lambda_function.report_renderer[0].layers == tolist(["arn:aws:lambda:ap-south-1:123456789012:layer:chromium:3"]) && aws_lambda_function.report_renderer[0].filename == "tests/fixtures/renderer.zip" && aws_lambda_function.report_renderer[0].source_code_hash == filebase64sha256("tests/fixtures/renderer.zip")
    error_message = "function uses the overrides"
  }
}

# The server's render timeout must outlast a redelivery: visibility (600 s) + function (300 s).
run "render_timeout_below_redelivery_refused" {
  command = plan
  variables {
    enable_reports                 = true
    reports_render_timeout_seconds = 899
  }
  expect_failures = [aws_sqs_queue.report_jobs]
}

run "render_timeout_raised" {
  command = apply
  variables {
    enable_reports                 = true
    reports_render_timeout_seconds = 1800
  }
  assert {
    condition     = strcontains(output.reports_server_env, "\nAGENCY_REPORTS_RENDER_TIMEOUT_MS=1800000\n")
    error_message = "render timeout line"
  }
}

run "rollback_pins_alias" {
  command = apply
  variables {
    enable_reports               = true
    report_renderer_live_version = "2"
  }
  assert {
    condition     = aws_lambda_alias.report_renderer_live[0].function_version == "2"
    error_message = "rollback version"
  }
}
