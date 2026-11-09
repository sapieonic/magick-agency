variable "environment" {
  type        = string
  description = "Environment name, e.g. dev-manas, staging, production. Part of every resource name, and must equal the selected Terraform workspace (each environment keeps its own state)."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$", var.environment))
    error_message = "environment must be 2-24 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}

variable "region" {
  type        = string
  description = "AWS region for the bucket (and the server VM, when create_server is true). Must match the server's AWS_REGION."
  default     = "ap-south-1"
}

variable "aws_profile" {
  type        = string
  description = "Named AWS CLI profile to apply with. Null uses the default credential chain (AWS_PROFILE, env keys, SSO)."
  default     = null
}

variable "name_prefix" {
  type        = string
  description = "Prefix of every resource name."
  default     = "magick-agency"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,20}$", var.name_prefix))
    error_message = "name_prefix must be 1-21 characters of lowercase letters, digits and hyphens."
  }
}

variable "bucket_name" {
  type        = string
  description = "Exact bucket name, overriding the default <name_prefix>-<environment>-<account id>. S3 names are global, so the default carries the account id to stay unique."
  default     = null
}

variable "force_destroy" {
  type        = bool
  description = "Let `terraform destroy` delete a bucket that still holds objects. Handy for a throwaway dev environment; leave false anywhere the data matters (uploaded contact lists, abandon clips)."
  default     = false
}

variable "create_access_key" {
  type        = bool
  description = "Create an access key for the server's IAM user. The server reads S3 credentials only from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, so it needs one. The secret is stored in this module's state, so keep the state private."
  default     = true
}

variable "noncurrent_version_expiration_days" {
  type        = number
  description = "Days a replaced or deleted object version is kept before S3 removes it. 0 leaves versioning off."
  default     = 0

  validation {
    condition     = var.noncurrent_version_expiration_days >= 0
    error_message = "noncurrent_version_expiration_days must be 0 (versioning off) or a positive number of days."
  }
}

# ── Server VM (ec2.tf) ────────────────────────────────────────────────────────────────

variable "create_server" {
  type        = bool
  description = "Create the EC2 instance that runs docker/docker-compose.prod.yml, its security group and an Elastic IP. Off by default, so a bucket-only environment gets no VM."
  default     = false
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type. Default 2 vCPU / 4 GB (t3.medium); with the image build on the box, the swap file (swap_gb) carries the peaks. t4g.medium (arm64, cheaper) works too; the AMI follows the type's architecture."
  default     = "t3.medium"
}

variable "root_volume_gb" {
  type        = number
  description = "Root volume size (gp3, encrypted). Docker images, build cache, container logs and the swap file live here; prune old images and build cache (`docker system prune`) to stay inside 20 GB."
  default     = 20

  validation {
    condition     = var.root_volume_gb >= 20
    error_message = "root_volume_gb must be at least 20: the image build alone needs several GB."
  }
}

variable "swap_gb" {
  type        = number
  description = "Swap file size made at first boot. 0 makes none. EC2 has no swap by default."
  default     = 2

  validation {
    condition     = var.swap_gb >= 0 && floor(var.swap_gb) == var.swap_gb
    error_message = "swap_gb must be a whole number, 0 or more."
  }
}

variable "ami_id" {
  type        = string
  description = "Exact AMI to launch. Null picks the latest Ubuntu 26.04 LTS for the instance type's architecture (looked up at the first apply only; later AMIs never replace the instance)."
  default     = null
}

variable "subnet_id" {
  type        = string
  description = "Public subnet for the instance. Null picks a default subnet of the default VPC."
  default     = null
}

variable "ssh_cidrs" {
  type        = list(string)
  description = "IPv4 CIDRs allowed to SSH in, e.g. [\"198.51.100.7/32\"]. Empty opens no SSH port; use Session Manager (enable_ssm) instead."
  default     = []

  validation {
    condition     = alltrue([for c in var.ssh_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0"])
    error_message = "ssh_cidrs must be valid IPv4 CIDRs, and not 0.0.0.0/0."
  }
}

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key to log in as `ubuntu` with; a key pair is created from it. Leave null to use key_name, or no key at all with Session Manager."
  default     = null
}

variable "key_name" {
  type        = string
  description = "Name of an existing EC2 key pair, instead of ssh_public_key."
  default     = null
}

variable "enable_instance_connect" {
  type        = bool
  description = "Open port 22 to AWS's EC2 Instance Connect range for the region, so the console's \"EC2 Instance Connect\" tab gives a browser SSH session. Needs no key pair: the console pushes a short-lived key."
  default     = false
}

variable "enable_ssm" {
  type        = bool
  description = "Give the instance a role with AmazonSSMManagedInstanceCore, for Session Manager shells and port forwarding (the super-admin tunnel) without an open SSH port."
  default     = true
}

# ── Reports (reports.tf) ──────────────────────────────────────────────────────────────

variable "enable_reports" {
  type        = bool
  description = "Create the report-jobs queue (and its dead-letter queue), the report-renderer Lambda with its `live` alias, its Chromium layer, the callback secret in SSM, the bucket's lifecycle rules for report-datasets/ and reports/, and the server's sqs:SendMessage. Off by default: an environment plans no change until it is switched on (aws/README.md, \"Reports\")."
  default     = false
}

variable "report_renderer_zip" {
  type        = string
  description = "A prebuilt renderer Lambda zip to deploy instead of building one. Null (the default) builds it from this checkout at every plan (scripts/build-report-renderer.mjs, which needs Node 22 and pnpm 10); the build is reproducible, so an unchanged checkout publishes no new version. Relative paths resolve from aws/terraform."
  default     = null
}

variable "report_renderer_handler" {
  type        = string
  description = "The function's handler: the bundle dist/lambda/index.mjs sits at the zip's root and exports `handler`."
  default     = "index.handler"
}

variable "report_renderer_chromium_layer_arn" {
  type        = string
  description = "Versioned ARN of an existing @sparticuz/chromium x86_64 layer to use instead of publishing one. Null (the default) publishes the layer this module pins for the renderer's @sparticuz/chromium version (apps/report-renderer/chromium-layer.json). An override's Chromium must match the puppeteer-core the renderer pins."
  default     = null

  validation {
    condition     = var.report_renderer_chromium_layer_arn == null || can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:layer:[A-Za-z0-9_-]+:[0-9]+$", var.report_renderer_chromium_layer_arn))
    error_message = "report_renderer_chromium_layer_arn must be a versioned layer ARN, arn:aws:lambda:<region>:<account>:layer:<name>:<version>."
  }
}

variable "reports_callback_secret_generation" {
  type        = number
  description = "Generation of the callback secret (AGENCY_REPORTS_CALLBACK_SECRET), which this module generates and keeps in SSM. Raise it by one to rotate; aws/README.md, \"Rotating the callback secret\", has the order that keeps callbacks in flight verifying."
  default     = 1

  validation {
    condition     = var.reports_callback_secret_generation >= 1 && floor(var.reports_callback_secret_generation) == var.reports_callback_secret_generation
    error_message = "reports_callback_secret_generation must be a whole number, 1 or more."
  }
}

variable "reports_callback_secret_sign_with_previous" {
  type        = bool
  description = "Whether the Lambda signs with the previous generation instead of the current one. Set for one apply during a rotation, together with the raised generation, so the server can take the new secret before the Lambda uses it."
  default     = false
  # Needs a previous generation: checked by the function's precondition (reports.tf).
}

variable "report_renderer_live_version" {
  type        = string
  description = "Published version the `live` alias points at. Null follows the version the latest apply published; set an older number to roll back (aws/README.md, \"Reports\")."
  default     = null

  validation {
    condition     = var.report_renderer_live_version == null || can(regex("^[1-9][0-9]*$", coalesce(var.report_renderer_live_version, "1")))
    error_message = "report_renderer_live_version must be a published version number, e.g. \"7\"."
  }
}

variable "reports_render_timeout_seconds" {
  type        = number
  description = "The server's AGENCY_REPORTS_RENDER_TIMEOUT_MS, in seconds (reports_server_env prints it in milliseconds): how long the server waits for a render attempt's callback, from the send, before re-sending or failing the run (RP13). At least the report-jobs visibility timeout plus the function's timeout (900 s), so an SQS redelivery finishes inside it; raise it for large bursts (docs/operations.md, \"Reports: sizing the render timeout\")."
  default     = 900

  validation {
    condition     = floor(var.reports_render_timeout_seconds) == var.reports_render_timeout_seconds && var.reports_render_timeout_seconds <= 86400
    error_message = "reports_render_timeout_seconds must be a whole number of seconds, at most 86400 (the server's ceiling)."
  }
}

variable "report_retention_days" {
  type        = number
  description = "Days the rendered files under reports/ are kept before S3 expires them (RP8). Keep it equal to the server's AGENCY_REPORTS_RETENTION_DAYS, which turns the run `expired` at the same age. Datasets under report-datasets/ expire after 7 days."
  default     = 90

  validation {
    condition     = var.report_retention_days >= 1 && floor(var.report_retention_days) == var.report_retention_days
    error_message = "report_retention_days must be a whole number of days, 1 or more."
  }
}

variable "report_renderer_log_retention_days" {
  type        = number
  description = "Retention of the renderer's CloudWatch log group. One of CloudWatch's allowed values (1, 3, 5, 7, 14, 30, 60, 90, ...)."
  default     = 30
}

variable "extra_tags" {
  type        = map(string)
  description = "Tags added to every resource, on top of Project, Environment, ManagedBy and Module."
  default     = {}
}
