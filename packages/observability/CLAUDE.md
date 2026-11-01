# packages/observability

Logger (pino, PII masking), log context, crypto, tracing (`@Traced`, `withSpan`), URL scrubbing,
the version, and the metric declarations. Server-side wiring of the OTel SDK is in
`apps/server/src/instrumentation.ts` and `apps/server/src/utils/otel-sdk-config.ts`
(`docs/architecture.md` "Observability").

## Metrics

- Declare a metric only in `src/metrics/<area>.ts` (platform, agency, voice, analysis, shared),
  through the facades in `src/metric-instruments.ts`: `counter<'label_a' | 'label_b'>(meter,
  'name', {…})`. The type argument is the label set. An instrument created anywhere else is
  reported by the Grafana validators.
- `test/fixtures/agency-otlp-instruments.json` snapshots the `agency_*` instruments
  (`metrics-agency.test.ts`): update it with any change to `metrics/agency.ts`.
- Renaming or relabelling a metric breaks the alert rules and dashboard in `grafana/`. Run
  `pnpm test:grafana` from the repo root (it reads these files as text) and fix
  `grafana/terraform/alert-rules.tf` and `grafana/dashboards/` in the same commit
  (`grafana/README.md`).
- Live data: the repo's `.mcp.json` Grafana MCP server (stack `sapieonic`).
