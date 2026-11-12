import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The push senders' instruments in `src/metrics/platform.ts` (Mode B; the server's
 * `notifications/push/`): each created once, with its kind, description, unit and buckets, and
 * declared with exactly its label keys; `trackPushSend` writes them. `@opentelemetry/api` is mocked
 * so the meter records what each instrument is created as and what is written to it. (The
 * `agency-otlp-instruments.json` snapshot covers `metrics/agency.ts` only.)
 */

const otel = vi.hoisted(() => ({
  captured: [] as Array<{ name: string; kind: string; options: Record<string, unknown> }>,
  writes: [] as Array<{ name: string; value: number; attrs?: Record<string, unknown> }>,
}));

vi.mock('@opentelemetry/api', () => {
  const record = (kind: string) => (name: string, options?: Record<string, unknown>) => {
    otel.captured.push({ name, kind, options: options ?? {} });
    const write = (value: number, attrs?: Record<string, unknown>) => { otel.writes.push({ name, value, attrs }); };
    return { add: write, record: write, addCallback: () => {} };
  };
  return {
    metrics: {
      getMeter: () => ({
        createCounter: record('Counter'),
        createHistogram: record('Histogram'),
        createObservableGauge: record('ObservableGauge'),
        createUpDownCounter: record('UpDownCounter'),
        createGauge: record('Gauge'),
        createObservableCounter: record('ObservableCounter'),
        createObservableUpDownCounter: record('ObservableUpDownCounter'),
      }),
    },
  };
});

const { trackPushSend } = await import('../src/metrics/platform.js');

const SOURCE = readFileSync(resolve(__dirname, '../src/metrics/platform.ts'), 'utf8');

function declaredLabels(name: string): string[] | undefined {
  const re = new RegExp(`\\b(?:counter|histogram|gauge|observableGauge)(?:<([^>]*)>)?\\(\\s*meter,\\s*'${name}'`);
  const m = re.exec(SOURCE);
  if (!m) return undefined;
  return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((l) => l[1]!);
}

beforeEach(() => { otel.writes.length = 0; });

describe('push sender instruments', () => {
  it('are created once each, as snapshotted', () => {
    const push = otel.captured.filter((c) => c.name.startsWith('agency_push_'));
    expect(push).toEqual([
      {
        name: 'agency_push_sends_total',
        kind: 'Counter',
        options: {
          description: 'Ring pushes to agents\' phones, by platform (android, ios) and result: ok, skipped (not sent: iOS gets ring and test_ring only), unregistered, invalid, rate_limited, unavailable or unconfigured',
        },
      },
      {
        name: 'agency_push_send_seconds',
        kind: 'Histogram',
        options: {
          description: 'Seconds a push send that reached for its carrier took, the OAuth or provider token included, by platform',
          unit: 's',
          advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5] },
        },
      },
    ]);
    const names = otel.captured.map((c) => c.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('are declared with exactly their label keys', () => {
    expect(declaredLabels('agency_push_sends_total')).toEqual(['platform', 'result']);
    expect(declaredLabels('agency_push_send_seconds')).toEqual(['platform']);
  });

  it('trackPushSend counts every send and times only those that reached for the carrier', () => {
    trackPushSend('android', 'ok', 0.2);
    trackPushSend('ios', 'skipped');
    trackPushSend('ios', 'unavailable', -1);
    expect(otel.writes).toEqual([
      { name: 'agency_push_sends_total', value: 1, attrs: { platform: 'android', result: 'ok' } },
      { name: 'agency_push_send_seconds', value: 0.2, attrs: { platform: 'android' } },
      { name: 'agency_push_sends_total', value: 1, attrs: { platform: 'ios', result: 'skipped' } },
      { name: 'agency_push_sends_total', value: 1, attrs: { platform: 'ios', result: 'unavailable' } },
      { name: 'agency_push_send_seconds', value: 0, attrs: { platform: 'ios' } },
    ]);
  });
});
