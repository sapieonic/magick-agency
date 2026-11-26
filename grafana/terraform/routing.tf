###############################################################################
# Agency's alert routing: one Slack contact point, the nightly mute timings and
# the stack's notification policy.
#
# magickagency.grafana.net carries only agency, so this module owns the stack's
# routing (decision B6, amended 2026-11-26). The notification policy is a
# Grafana SINGLETON: applying it replaces the stack's whole routing tree, so
# nothing else may manage routing on this stack. `terraform destroy` resets it
# to Grafana's default (the default email contact point).
#
# Every alert, critical and warning, from every deployment, goes to one Slack
# channel through an incoming webhook. Nothing pages: a critical is a Slack
# message re-sent hourly while it fires. The webhook URL is a secret: it comes
# in as TF_VAR_slack_webhook_url and never lands in the repo
# (grafana/scripts/validate-alerts.test.mjs refuses a literal one). It is kept
# in plain text in the S3 state, like every secret Terraform manages.
#
# The tree, first match wins (the same shape the shared sapieonic stack used):
#
#   DatasourceError                      grouped by datasource, so one broken
#                                        datasource is one message
#   staging|dedicated + nightly_window   muted overnight (the nightly shutdown):
#     staging                              22:15–09:45 IST, re-sent daily
#     critical                             22:15–08:30 IST, re-sent hourly
#     (other)                              22:15–08:30 IST
#   staging                              re-sent daily
#   critical                             re-sent hourly
#   (everything else)                    re-sent every 4 hours
#
# The policy groups by grafana_folder, alertname and deployment, so a staging
# firing and a production firing of one rule are separate messages.
###############################################################################

resource "grafana_contact_point" "agency_slack" {
  name = var.slack_contact_point_name

  slack {
    url = var.slack_webhook_url
  }
}

# Staging and dedicated are shut down overnight; these hide the firings that
# shutdown causes (rules labelled nightly_window = "mute" only).
resource "grafana_mute_timing" "nightly_staging" {
  name = "nightly-staging"

  intervals {
    location = "Asia/Kolkata"
    times {
      start = "22:15"
      end   = "24:00"
    }
    times {
      start = "00:00"
      end   = "09:45"
    }
  }
}

resource "grafana_mute_timing" "nightly_dedicated" {
  name = "nightly-dedicated"

  intervals {
    location = "Asia/Kolkata"
    times {
      start = "22:15"
      end   = "24:00"
    }
    times {
      start = "00:00"
      end   = "08:30"
    }
  }
}

resource "grafana_notification_policy" "this" {
  contact_point   = grafana_contact_point.agency_slack.name
  group_by        = ["grafana_folder", "alertname", "deployment"]
  group_wait      = "30s"
  group_interval  = "5m"
  repeat_interval = "4h"

  # A rule whose query errors (exec_err_state = "Error") fires DatasourceError.
  policy {
    matcher {
      label = "alertname"
      match = "="
      value = "DatasourceError"
    }
    contact_point = grafana_contact_point.agency_slack.name
    group_by      = ["alertname", "datasource_uid"]
  }

  policy {
    matcher {
      label = "deployment"
      match = "=~"
      value = "staging|dedicated"
    }
    matcher {
      label = "nightly_window"
      match = "="
      value = "mute"
    }
    contact_point = grafana_contact_point.agency_slack.name
    mute_timings  = [grafana_mute_timing.nightly_dedicated.name]

    policy {
      matcher {
        label = "deployment"
        match = "="
        value = "staging"
      }
      contact_point   = grafana_contact_point.agency_slack.name
      mute_timings    = [grafana_mute_timing.nightly_staging.name]
      repeat_interval = "1d"
    }

    policy {
      matcher {
        label = "severity"
        match = "="
        value = "critical"
      }
      contact_point   = grafana_contact_point.agency_slack.name
      mute_timings    = [grafana_mute_timing.nightly_dedicated.name]
      repeat_interval = "1h"
    }
  }

  policy {
    matcher {
      label = "deployment"
      match = "="
      value = "staging"
    }
    contact_point   = grafana_contact_point.agency_slack.name
    repeat_interval = "1d"
  }

  policy {
    matcher {
      label = "severity"
      match = "="
      value = "critical"
    }
    contact_point   = grafana_contact_point.agency_slack.name
    repeat_interval = "1h"
  }
}
