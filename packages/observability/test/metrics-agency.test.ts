import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import fixture from './fixtures/agency-otlp-instruments.json';

/**
 * The agency runtime's metric declarations (`src/metrics/agency.ts`) are pinned
 * here in two groups:
 *
 *  1. Instrument behaviour: the abandonment instruments and the pre-dial gate
 *     instruments are each created exactly once with the right label keys in the
 *     right order. There are no `agency_dnc_synced` cases — that gauge and its
 *     setter described a Redis DNC set that decision B8 removes.
 *  2. An OTLP contract over the agency rows of the committed instrument snapshot
 *     `./fixtures/agency-otlp-instruments.json`: names, kinds, descriptions, units,
 *     buckets and attribute keys. The captured instruments and declarations are
 *     filtered to `agency_*` because the file also holds two S3 series.
 *
 * `@opentelemetry/api` is mocked so the meter is a stand-in that records what each
 * instrument is created as and with which options; label keys are read from the
 * facade's generic in the source.
 */

type ObserveCallback = (result: { observe: (value: number, attrs?: Record<string, unknown>) => void }) => void;
type Captured = { name: string; kind: string; options: Record<string, unknown> };

const otel = vi.hoisted(() => ({
  created: [] as Array<{ kind: 'counter' | 'histogram' | 'gauge'; name: string }>,
  captured: [] as Array<{ name: string; kind: string; options: Record<string, unknown> }>,
  gauges: new Map<string, (result: { observe: (value: number, attrs?: Record<string, unknown>) => void }) => void>(),
}));

vi.mock('@opentelemetry/api', () => {
  const record = (kind: string, short?: 'counter' | 'histogram' | 'gauge') =>
    (name: string, options?: Record<string, unknown>) => {
      otel.captured.push({ name, kind, options: options ?? {} });
      if (short) otel.created.push({ kind: short, name });
      return {
        add: () => {},
        record: () => {},
        addCallback: (cb: ObserveCallback) => { otel.gauges.set(name, cb); },
      };
    };
  return {
    metrics: {
      getMeter: () => ({
        createCounter: record('Counter', 'counter'),
        createHistogram: record('Histogram', 'histogram'),
        createObservableGauge: record('ObservableGauge', 'gauge'),
        createUpDownCounter: record('UpDownCounter'),
        createGauge: record('Gauge'),
        createObservableCounter: record('ObservableCounter'),
        createObservableUpDownCounter: record('ObservableUpDownCounter'),
      }),
    },
  };
});

await import('../src/metrics/agency.js');

const SOURCE = readFileSync(resolve(__dirname, '../src/metrics/agency.ts'), 'utf8');

function names(kind: 'counter' | 'histogram' | 'gauge'): string[] {
  return otel.created.filter((c) => c.kind === kind).map((c) => c.name);
}

/** The attribute keys `name` is declared with — its facade generic, in order. */
function declaredLabels(name: string): string[] | undefined {
  const re = new RegExp(`\\b(?:counter|histogram|gauge|observableGauge)(?:<([^>]*)>)?\\(\\s*meter,\\s*'${name}'`);
  const m = re.exec(SOURCE);
  if (!m) return undefined;
  return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((l) => l[1]!);
}

describe('metrics', () => {
  describe('agency abandonment instruments', () => {
    it('creates all five instruments exactly once', () => {
      for (const name of ['agency_answered_total', 'agency_abandoned_total']) {
        expect(names('counter').filter((n) => n === name)).toHaveLength(1);
      }
      for (const name of [
        'agency_abandonment_rate_24h',
        'agency_abandonment_window_answered_24h',
        'agency_abandonment_window_abandoned_24h',
      ]) {
        expect(names('gauge').filter((n) => n === name)).toHaveLength(1);
      }
    });

    it('labels every series by tenant AND campaign, in that order', () => {
      // `campaign_id` is load-bearing rather than decorative: the SQL predicate
      // is per-campaign and US TSR measures per campaign, so a series without it
      // cannot be cross-checked against the table or read by the auto-pause
      // guardrail. Ordered assertion — this is the `no_balance_row` failure, where
      // facts that were distinguishable in code collapsed into one series.
      for (const name of [
        'agency_answered_total',
        'agency_abandoned_total',
        'agency_abandonment_rate_24h',
        'agency_abandonment_window_answered_24h',
        'agency_abandonment_window_abandoned_24h',
      ]) {
        expect(declaredLabels(name), name).toEqual(['tenant_id', 'campaign_id']);
      }
    });

    it('exports the rate AND both of its terms as separate series', () => {
      // A lone rate cannot distinguish 1-of-1 from 30-of-3000, and the auto-pause guardrail
      // pauses campaigns off this number.
      expect(names('gauge')).toContain('agency_abandonment_window_answered_24h');
      expect(names('gauge')).toContain('agency_abandonment_window_abandoned_24h');
    });
  });

  describe('agency pre-dial gate instruments', () => {
    // Both of these were prom-client-only in one direction or another, and
    // Grafana Cloud is fed by OTLP — so the alertable view was the unwritten one.
    it('creates the pre-dial gate counter once', () => {
      expect(names('counter').filter((n) => n === 'agency_predial_gate_total')).toHaveLength(1);
    });

    it('labels the gate counter by campaign, gate AND action, in that order', () => {
      // `gate` without `action` cannot separate a deferral from a suppression,
      // and `dnc_unavailable`/halt is the series the compliance alert reads.
      expect(declaredLabels('agency_predial_gate_total')).toEqual(['campaign_id', 'gate', 'action']);
    });

    // No DNC-synced gauge cases: that gauge and its setter are absent — decision B8 (see the header).
  });
});

// ── OTLP contract, over the agency rows ─────────────────────────────────────

type FixtureEntry = (typeof fixture)[number] & { unit?: string; advice?: unknown };

function instrumentsFromFixture(): Array<Omit<FixtureEntry, 'attributes'>> {
  return (fixture as FixtureEntry[]).map(({ attributes: _attributes, ...rest }) => rest);
}

/** Filtered to `agency_*` — the file also declares two S3 series. */
function agencyCaptured(): Captured[] {
  return otel.captured.filter((c) => c.name.startsWith('agency_'));
}

function instrumentsFromModule(): Array<Record<string, unknown>> {
  return agencyCaptured()
    .map(({ name, kind, options }) => ({ name, kind, ...options }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The attribute keys each metric is declared with, read from the facade calls —
 * `counter<'provider' | 'reason'>(meter, 'name', …)`. Comments are stripped first so a
 * quoted example in prose cannot satisfy the audit.
 */
function declaredAttributes(): Record<string, string[][]> {
  const source = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'])\/\/.*$/gm, '$1');
  const out: Record<string, string[][]> = {};
  const declaration = /\b(?:counter|histogram|gauge|observableGauge)(?:<([^>]*)>)?\(\s*meter,\s*'([^']+)'/g;
  for (const m of source.matchAll(declaration)) {
    if (!m[2]!.startsWith('agency_')) continue; // the agency rows only
    const keys = [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map(k => k[1]!).sort();
    (out[m[2]!] ??= []).push(keys);
  }
  return out;
}

describe('metrics OTLP contract', () => {
  it('creates exactly the snapshotted instruments: names, kinds, descriptions, units, buckets', () => {
    expect(instrumentsFromModule()).toEqual(instrumentsFromFixture());
  });

  it('creates each instrument once — a second create of a name forks its series', () => {
    const names = otel.captured.map(c => c.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('declares each metric once, through a facade, with exactly the snapshotted attribute keys', () => {
    const declared = declaredAttributes();
    // Canary: a regex that silently stopped matching would pass vacuously.
    // This file declares the 15 agency series.
    expect(Object.keys(declared).length).toBeGreaterThan(10);
    const expected = Object.fromEntries(
      (fixture as FixtureEntry[]).map(e => [e.name, [[...e.attributes].sort()]]),
    );
    expect(declared).toEqual(expected);
  });
});
