import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';
import {
  DEFAULT_METRICS_EXPORT_INTERVAL_MS,
  buildResourceAttributes,
  resolveMetricsExportIntervalMs,
} from '../../../src/utils/otel-sdk-config.js';

/**
 * `config.otel` mirrors what `src/instrumentation.ts` resolves from the same variables. The SDK
 * cannot read the config (it loads first), so these cases pin that the two agree.
 */
const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function otel(env: Record<string, string>) {
  const result = parseConfig({ ...valid, ...env });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config.otel;
}

describe('config.otel', () => {
  it('is off by default, with the SDK defaults', () => {
    expect(otel({})).toEqual({
      enabled: false,
      endpoint: undefined,
      exporting: false,
      metricsExportIntervalMs: DEFAULT_METRICS_EXPORT_INTERVAL_MS,
      serviceName: 'magick-agency',
      serviceInstanceIdEnabled: false,
    });
  });

  it('exports only when OTEL_ENABLED is exactly "true" AND an endpoint AND a service name are set, as instrumentation.ts gates it', () => {
    const endpoint = 'http://localhost:4318';
    const named = { OTEL_SERVICE_NAME: 'magick-agency-Staging' };
    expect(otel({ ...named, OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint })).toMatchObject({ exporting: true, endpoint });
    expect(otel({ ...named, OTEL_ENABLED: 'true' }).exporting).toBe(false);
    expect(otel({ ...named, OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: '' }).exporting).toBe(false);
    for (const v of ['TRUE', '1', 'yes', '']) {
      expect(otel({ ...named, OTEL_ENABLED: v, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).exporting).toBe(false);
    }
    // Unnamed, the fallback would be Grafana's production name: no export (Manas, 2026-10-09).
    for (const unnamed of [{}, { OTEL_SERVICE_NAME: '' }] as Record<string, string>[]) {
      const o = otel({ ...unnamed, OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
      expect(o).toMatchObject({ exporting: false, serviceName: 'magick-agency' });
    }
  });

  it('resolves the export interval with the SDK resolver, so a bad value falls back instead of failing boot', () => {
    for (const raw of ['15000', '-1', 'abc', '0', '1e12', '']) {
      expect(otel({ OTEL_METRICS_EXPORT_INTERVAL_MS: raw }).metricsExportIntervalMs)
        .toBe(resolveMetricsExportIntervalMs(raw));
    }
  });

  it('names the service and gates service.instance.id the way the SDK resource does', () => {
    const hostname = () => 'h';
    for (const env of [{}, { OTEL_SERVICE_NAME: 'svc' }, { OTEL_SERVICE_NAME: '' }] as Record<string, string>[]) {
      expect(otel(env).serviceName).toBe(buildResourceAttributes(env, { version: '0', hostname })['service.name']);
    }
    for (const v of ['true', 'TRUE', 'false']) {
      const env = { OTEL_SERVICE_INSTANCE_ID_ENABLED: v };
      expect(otel(env).serviceInstanceIdEnabled)
        .toBe('service.instance.id' in buildResourceAttributes(env, { version: '0', hostname }));
    }
  });
});
