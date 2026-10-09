variable "grafana_url" {
  type        = string
  description = "Grafana Cloud stack URL, e.g. https://sapieonic.grafana.net. Falls back to the GRAFANA_URL env var when empty."
  default     = ""
}

variable "grafana_auth" {
  type        = string
  sensitive   = true
  description = "Grafana service account token (dashboards and alerting writer). Falls back to the GRAFANA_AUTH env var when empty."
  default     = ""
}

variable "stack_id" {
  type        = number
  description = "Grafana Cloud stack ID (the N in the \"stacks-N\" namespace). 1508287 is sapieonic.grafana.net."
  default     = 1508287
}

variable "folder_uid" {
  type        = string
  description = "UID of the folder this module creates for agency's alert rules and dashboard."
  default     = "magick-agency-alerts"
}

variable "folder_title" {
  type        = string
  description = "Title of that folder. Platform's notification policy groups by grafana_folder, so this appears in alert notifications."
  default     = "Magick Agency Alerts"
}

variable "allow_ui_updates" {
  type        = bool
  description = "Allow saving the dashboard from the Grafana UI. UI edits are reverted by the next apply unless exported back into the JSON."
  default     = false
}

variable "agency_service_name_regex" {
  type        = string
  description = "Regex (fully anchored) matching every magick-agency deployment's service_name: magick-agency in production, magick-agency-Staging and magick-agency-Dedicated, set through OTEL_SERVICE_NAME (case-sensitive). The deployment routing label keys on the -Staging / -Dedicated suffix, so any other name this matches routes as production. The dashboard's service_name variable repeats this default; the validators keep the two equal."
  default     = "magick-agency(-.+)?"
}

variable "prometheus_datasource_uid" {
  type        = string
  description = "UID (not name) of the Prometheus datasource holding agency's OTLP metrics."
  default     = "grafanacloud-prom"
}

variable "loki_datasource_uid" {
  type        = string
  description = "UID of the Loki datasource holding agency's logs."
  default     = "grafanacloud-logs"
}

variable "alert_eval_interval_seconds" {
  type        = number
  description = "How often every rule group is evaluated."
  default     = 60
}

variable "grafana_public_url" {
  type        = string
  description = "Browser URL of the stack, used to build dashboard links in alert annotations."
  default     = "https://sapieonic.grafana.net"
}
