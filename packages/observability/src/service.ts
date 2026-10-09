/**
 * OTel `service.name` for this app. Grafana alert rules route on
 * `service_name`, so this value is what the platform's `local.agency`
 * selector (grafana/terraform) must match. Metric NAMES are unchanged from
 * core/master; only the service differs.
 */
export const SERVICE_NAME = 'magick-agency';
