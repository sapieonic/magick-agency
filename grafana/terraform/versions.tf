terraform {
  # 1.10 for the S3 backend's lock file (use_lockfile).
  required_version = ">= 1.10.0"

  # State lives in the same S3 bucket as aws/terraform's, under its own key, so any machine with
  # AWS access can plan and apply (grafana/README.md, "Apply"; the bucket is made by aws/state).
  # The backend authenticates with the usual AWS chain (AWS_PROFILE, SSO, env keys); the
  # Grafana token below is separate.
  backend "s3" {
    bucket       = "magick-agency-terraform-state"
    key          = "grafana/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.0"
    }
  }
}

# Auth via env vars so no secrets land in version control:
#   export GRAFANA_URL="https://sapieonic.grafana.net"
#   export GRAFANA_AUTH="<service-account-token: dashboards + alerting writer>"
provider "grafana" {
  # An empty string would override the provider's env-var fallback.
  url  = var.grafana_url != "" ? var.grafana_url : null
  auth = var.grafana_auth != "" ? var.grafana_auth : null
  # App-platform resources on Cloud live in the "stacks-<id>" namespace; without this they 403.
  stack_id = var.stack_id
}
