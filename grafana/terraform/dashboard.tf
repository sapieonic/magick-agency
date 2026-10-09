###############################################################################
# Agency overview dashboard as code
#
# The source of truth is ../dashboards/magick-agency-overview.json (the classic
# dashboard model, covered by grafana/scripts/validate-dashboard.test.mjs).
# Grafana Cloud runs v13, so this uses the app-platform dashboard resource.
###############################################################################

locals {
  dashboard = jsondecode(file("${path.module}/../dashboards/magick-agency-overview.json"))
}

resource "grafana_apps_dashboard_dashboard_v1beta1" "agency_overview" {
  metadata {
    uid        = local.dashboard.uid
    folder_uid = grafana_folder.agency.uid
  }

  spec {
    # Grafana owns id/version; leaving them in causes a perpetual diff.
    json = jsonencode({
      for k, v in local.dashboard : k => v if !contains(["id", "version"], k)
    })
  }

  options {
    overwrite        = true
    allow_ui_updates = var.allow_ui_updates
  }
}

output "dashboard_url" {
  value = grafana_apps_dashboard_dashboard_v1beta1.agency_overview.metadata.url
}
