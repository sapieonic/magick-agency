terraform {
  required_version = ">= 1.5.0"

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
