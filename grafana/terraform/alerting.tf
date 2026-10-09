###############################################################################
# Agency alerting: the folder, the selector, and the one grafana_rule_group
# resource every rule goes through.
#
# ROUTING IS NOT HERE. The stack has ONE notification policy (a Grafana
# singleton), managed outside this repo together with the contact points
# (AlertInSlack, AlertInPagerDuty) and the nightly mute timings. This module
# must never manage any of those: applying a policy from here would replace the
# stack's whole routing tree. Agency's alerts reach Slack and PagerDuty only
# because they carry the labels that policy routes on, so the labels below are a
# contract with the stack's routing (../README.md, "Routing"):
#
#   severity       critical | warning   — critical pages (production, dedicated)
#   deployment     templated from service_name, as the policy expects:
#                  -Staging → staging, -Dedicated → dedicated, else production
#   nightly_window "mute" on rules whose staging/dedicated firings are the
#                  nightly shutdown (the stack's mute timings apply)
#   service        "agency" — the PagerDuty incident's component
#   component      the rule group — the PagerDuty incident's class
#
# The policy groups by grafana_folder, alertname and deployment. The validators
# (grafana/scripts/validate-alerts.test.mjs) pin the deployment template text
# and refuse any other rule label.
#
# Each rule is an instant query (refId A) feeding a threshold expression
# (refId B). Rule fields: uid, name, expr,
# op, threshold, for, severity, no_data_state, summary, description — plus
# optional datasource ("prom" default, "loki"), range_seconds (default 600),
# keep_firing_for, labels (nightly_window only) and runbook_url.
###############################################################################

resource "grafana_folder" "agency" {
  uid                          = var.folder_uid
  title                        = var.folder_title
  prevent_destroy_if_not_empty = true
}

locals {
  # Every expression selects agency's deployments, and only them.
  agency = "service_name=~\"${var.agency_service_name_regex}\""

  # Which deployment an alert instance belongs to, templated from its
  # service_name at evaluation time. deployment_environment cannot be used:
  # staging reports deployment_environment="production" and is told apart only
  # by its -Staging service name. The stack's notification policy routes on
  # this label, so its text is pinned by the routing test (change it only with
  # the policy), and every rule keeps service_name through its aggregation.
  deployment_label = "{{ if match \"-Staging$\" $labels.service_name }}staging{{ else if match \"-Dedicated$\" $labels.service_name }}dedicated{{ else if $labels.service_name }}production{{ else }}unknown{{ end }}"

  alert_datasources = {
    prom = var.prometheus_datasource_uid
    loki = var.loki_datasource_uid
  }
}

resource "grafana_rule_group" "this" {
  for_each = local.agency_groups

  name             = each.key
  folder_uid       = grafana_folder.agency.uid
  interval_seconds = var.alert_eval_interval_seconds

  dynamic "rule" {
    for_each = each.value

    content {
      name           = rule.value.name
      uid            = rule.value.uid
      condition      = "B"
      for            = rule.value.for
      no_data_state  = rule.value.no_data_state
      exec_err_state = "Error"
      # Optional: hold the alert firing this long after the condition clears.
      keep_firing_for = try(rule.value.keep_firing_for, null)

      # refId A — the instant query.
      data {
        ref_id         = "A"
        datasource_uid = local.alert_datasources[try(rule.value.datasource, "prom")]
        query_type     = try(rule.value.datasource, "prom") == "loki" ? "instant" : null
        relative_time_range {
          from = try(rule.value.range_seconds, 600)
          to   = 0
        }
        model = try(rule.value.datasource, "prom") == "loki" ? jsonencode({
          refId         = "A"
          datasource    = { type = "loki", uid = var.loki_datasource_uid }
          expr          = rule.value.expr
          queryType     = "instant"
          intervalMs    = 1000
          maxDataPoints = 43200
          }) : jsonencode({
          refId         = "A"
          datasource    = { type = "prometheus", uid = var.prometheus_datasource_uid }
          expr          = rule.value.expr
          instant       = true
          range         = false
          intervalMs    = 1000
          maxDataPoints = 43200
        })
      }

      # refId B — threshold on A; this is the alert condition.
      data {
        ref_id         = "B"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          refId      = "B"
          type       = "threshold"
          datasource = { type = "__expr__", uid = "__expr__" }
          expression = "A"
          conditions = [{
            type      = "query"
            evaluator = { type = rule.value.op, params = [rule.value.threshold] }
            operator  = { type = "and" }
            query     = { params = [] }
            reducer   = { type = "last", params = [] }
          }]
        })
      }

      labels = merge({
        severity   = rule.value.severity
        service    = "agency"
        component  = each.key
        deployment = local.deployment_label
      }, try(rule.value.labels, {}))

      annotations = merge({
        summary       = rule.value.summary
        description   = rule.value.description
        dashboard_url = "${var.grafana_public_url}/d/magick-agency-overview/?orgId=1{{ if $labels.service_name }}&var-service_name={{ $labels.service_name }}{{ end }}"
      }, try(rule.value.runbook_url, "") != "" ? { runbook_url = rule.value.runbook_url } : {})
    }
  }
}
