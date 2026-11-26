###############################################################################
# Agency's alert routing: one Slack contact point and the stack's notification
# policy.
#
# magickagency.grafana.net carries only agency, so this module owns the stack's
# routing (decision B6, amended 2026-11-26). The notification policy is a
# Grafana SINGLETON: applying it replaces the stack's whole routing tree, so
# nothing else may manage routing on this stack.
#
# Every alert, critical and warning, from every deployment, goes to one Slack
# channel through an incoming webhook. The webhook URL is a secret: it comes in
# as TF_VAR_slack_webhook_url and never lands in the repo
# (grafana/scripts/validate-alerts.test.mjs refuses a literal one).
#
# The policy groups by grafana_folder, alertname and deployment, so a staging
# firing and a production firing of one rule are separate messages. Criticals
# are re-sent hourly while they fire, warnings every 4 hours.
###############################################################################

resource "grafana_contact_point" "agency_slack" {
  name = var.slack_contact_point_name

  slack {
    url = var.slack_webhook_url
  }
}

resource "grafana_notification_policy" "this" {
  contact_point   = grafana_contact_point.agency_slack.name
  group_by        = ["grafana_folder", "alertname", "deployment"]
  group_wait      = "30s"
  group_interval  = "5m"
  repeat_interval = "4h"

  policy {
    matcher {
      label = "severity"
      match = "="
      value = "critical"
    }
    contact_point   = grafana_contact_point.agency_slack.name
    group_by        = ["grafana_folder", "alertname", "deployment"]
    repeat_interval = "1h"
  }
}
