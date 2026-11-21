import { describe, expect, it } from 'vitest';
import {
  COMPARE_MAX_METRICS,
  COMPARE_VIEW_NAME_MAX,
  compareMetricId,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
} from '@magick-agency/contracts/api/agency/compare';
import {
  checkCompareMetrics,
  checkCompareView,
  checkCompareWindow,
  cleanMetricRef,
  compareQueryBodySchema,
  COMPARE_ERROR_MESSAGES,
  uuidOf,
  type CompareViewDraft,
} from '../../../../src/agency/compare/validate.js';
import { AGENCY_COMPARE_ERROR_CODES } from '@magick-agency/contracts/api/agency/compare';

/**
 * Compare agents' request rules (docs/compare-agents.md §8): the refusal for each failure, in the
 * contract's order, and what a view must hold.
 */

const CODES: AgencyCompareOutcomeCode[] = [
  { code: 'interested', label: 'Interested', is_success: true, requires_promise: false },
  { code: 'will_pay', label: 'Will pay', is_success: false, requires_promise: true },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
];
const NO_PROMISES = CODES.filter((c) => !c.requires_promise);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const b = (key: string) => ({ kind: 'builtin', key }) as AgencyCompareMetricRef;
const set = (codes: string[], better = 'higher', label?: string) => ({ kind: 'outcomes', codes, better, ...(label ? { label } : {}) }) as AgencyCompareMetricRef;

describe('the query body schema (the generic 400)', () => {
  const ok = { agent_ids: [A], metrics: [b('calls_handled')], from: '2026-11-01', to: '2026-11-02' };
  it('accepts a body without campaign or zone (their absence has a compare code)', () => {
    expect(compareQueryBodySchema.safeParse(ok).success).toBe(true);
  });
  it.each([
    ['empty agents', { ...ok, agent_ids: [] }],
    ['a duplicated agent, case aside', { ...ok, agent_ids: [A, A.toUpperCase()] }],
    ['an agent that is not a uuid', { ...ok, agent_ids: ['agent-1'] }],
    ['empty metrics', { ...ok, metrics: [] }],
    ['a missing window end', { ...ok, to: undefined }],
  ])('refuses %s', (_label, body) => {
    expect(compareQueryBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('checkCompareMetrics', () => {
  it('too many agents comes before too many metrics, which comes before a bad metric', () => {
    const seven = Array.from({ length: COMPARE_MAX_METRICS + 1 }, () => ({ kind: 'nope' }));
    expect(checkCompareMetrics({ agent_ids: [A, B, C, D], metrics: seven, trend: null }, CODES)).toEqual({ ok: false, code: 'compare_too_many_agents' });
    expect(checkCompareMetrics({ agent_ids: [A], metrics: seven, trend: null }, CODES)).toEqual({ ok: false, code: 'compare_too_many_metrics' });
  });

  it.each([
    ['a non-object ref', ['success_rate'], undefined],
    ['an unknown key', [b('made_up')], undefined],
    ['a code not in the current catalog', [set(['gone'])], undefined],
    ['two refs with one id (codes reordered)', [set(['will_pay', 'refused']), set(['refused', 'will_pay'])], undefined],
    ['a promise metric on a catalog without promises', [b('promises_rate')], 'no_promises'],
    ['an uncountable trend', [b('calls_handled')], b('success_rate')],
    ['a non-object trend', [b('calls_handled')], 'success_rate'],
    ['a label with spaces around it', [set(['refused'], 'lower', ' Refused ')], undefined],
  ])('%s is compare_metric_invalid', (_label, metrics, trend) => {
    const codes = trend === 'no_promises' ? NO_PROMISES : CODES;
    const t = trend === 'no_promises' ? undefined : trend;
    expect(checkCompareMetrics({ agent_ids: [A], metrics: metrics as unknown[], trend: t }, codes)).toEqual({ ok: false, code: 'compare_metric_invalid' });
  });

  it('resolves the refs, lower-cases the agents and echoes only the ref\'s own fields', () => {
    const r = checkCompareMetrics({
      agent_ids: [A.toUpperCase(), B],
      metrics: [{ kind: 'builtin', key: 'success_rate', extra: 'dropped' }, set(['will_pay', 'interested'], 'higher')],
      trend: set(['will_pay'], 'higher', 'Will pay'),
    }, CODES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentIds).toEqual([A, B]);
    expect(r.resolved.metrics.map((m) => m.id)).toEqual(['success_rate', 'outcomes:higher:interested,will_pay']);
    expect(r.resolved.metrics[0]!.ref).toEqual({ kind: 'builtin', key: 'success_rate' });
    expect(r.resolved.metrics[1]!.label).toBe('Will pay or Interested');
    expect(r.resolved.trend).toMatchObject({ id: 'outcomes:higher:will_pay', label: 'Will pay', flaggable: true });
  });
});

describe('checkCompareWindow', () => {
  const today = () => '2026-11-21';
  const known = 'Postgres/Name';
  it('the zone first: missing, untrimmed, too long, unknown to Intl, unknown to Postgres', () => {
    for (const tz of [undefined, '', ' Asia/Kolkata', 'Mars/Olympus', `Asia/${'x'.repeat(60)}`]) {
      expect(checkCompareWindow({ from: '2026-11-01', to: '2026-11-02', timezone: tz }, known, today)).toEqual({ ok: false, code: 'compare_timezone_invalid' });
    }
    expect(checkCompareWindow({ from: '2026-11-01', to: '2026-11-02', timezone: 'Asia/Kolkata' }, null, today)).toEqual({ ok: false, code: 'compare_timezone_invalid' });
    expect(checkCompareWindow({ from: 'bad', to: 'bad', timezone: 'nope' }, known, today)).toEqual({ ok: false, code: 'compare_timezone_invalid' });
  });
  it.each([
    ['to after today', '2026-11-20', '2026-11-22'],
    ['to before from', '2026-11-10', '2026-11-09'],
    ['a malformed date', '2026-11-1', '2026-11-09'],
    ['31 days across two months', '2026-10-21', '2026-11-20'],
  ])('%s is compare_window_invalid', (_l, from, to) => {
    expect(checkCompareWindow({ from, to, timezone: 'UTC' }, known, today)).toEqual({ ok: false, code: 'compare_window_invalid' });
  });
  it('accepts up to today, and a whole 31-day month', () => {
    expect(checkCompareWindow({ from: '2026-11-21', to: '2026-11-21', timezone: 'Asia/Kolkata' }, known, today))
      .toEqual({ ok: true, timezone: 'Asia/Kolkata', databaseTimezone: known });
    expect(checkCompareWindow({ from: '2026-10-01', to: '2026-10-31', timezone: 'UTC' }, known, today)).toEqual({ ok: true, timezone: 'UTC', databaseTimezone: known });
  });
});

describe('checkCompareView', () => {
  const draft = (o: Partial<CompareViewDraft> = {}): CompareViewDraft => ({
    name: ' Morning ', lens: 'collections', metrics: [b('calls_handled'), set(['will_pay'])], trend: set(['will_pay']),
    campaign_id: A, shared: false, is_campaign_default: false, ...o,
  });

  it('stores the name trimmed and the refs clean', () => {
    expect(checkCompareView(draft({ metrics: [{ kind: 'builtin', key: 'avg_call', junk: 1 }] }), CODES)).toEqual({
      name: 'Morning', lens: 'collections', metrics: [{ kind: 'builtin', key: 'avg_call' }], trend: set(['will_pay']),
      campaign_id: A, shared: false, is_campaign_default: false,
    });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name too long', { name: 'x'.repeat(COMPARE_VIEW_NAME_MAX + 1) }],
    ['an unknown lens', { lens: 'inbound' }],
    ['no metrics', { metrics: [] }],
    ['too many metrics', { metrics: Array.from({ length: 7 }, (_, i) => b(['calls_handled', 'avg_call', 'choose_time', 'success_rate', 'connect_rate', 'calls_per_hour', 'no_outcome_rate'][i]!)) }],
    ['a default without sharing', { is_campaign_default: true }],
    ['a default without a campaign', { is_campaign_default: true, shared: true, campaign_id: null }],
    ['a code outside the catalog', { metrics: [set(['gone'])] }],
    ['an uncountable trend', { trend: b('avg_call') }],
  ])('refuses %s', (_l, o) => {
    expect(checkCompareView(draft(o as Partial<CompareViewDraft>), CODES)).toBeNull();
  });

  it('a view with no campaign checks shapes only: any well-formed code, promises allowed, ids distinct', () => {
    expect(checkCompareView(draft({ campaign_id: null, metrics: [set(['anything']), b('promises_rate')], trend: b('promises_rate') }), null)).not.toBeNull();
    expect(checkCompareView(draft({ campaign_id: null, metrics: [set(['a', 'b']), set(['b', 'a'])] }), null)).toBeNull();
    expect(checkCompareView(draft({ campaign_id: null, metrics: [set(['Bad Code'])] }), null)).toBeNull();
    expect(checkCompareView(draft({ campaign_id: null, trend: b('success_rate') }), null)).toBeNull();
  });

  it('a promise metric on a campaign whose catalog has none is refused', () => {
    expect(checkCompareView(draft({ metrics: [b('promises_rate')], trend: null }), NO_PROMISES)).toBeNull();
  });
});

describe('helpers', () => {
  it('uuidOf lower-cases a UUID and refuses anything else', () => {
    expect(uuidOf(A.toUpperCase())).toBe(A);
    expect(uuidOf('nope')).toBeNull();
    expect(uuidOf(42)).toBeNull();
  });
  it('cleanMetricRef keeps an outcome set\'s label and id', () => {
    const ref = set(['refused', 'will_pay'], 'lower', 'Refused or will pay');
    expect(cleanMetricRef(ref)).toEqual(ref);
    expect(compareMetricId(cleanMetricRef(ref))).toBe(compareMetricId(ref));
  });
  it('every compare code has English fallback copy', () => {
    for (const code of AGENCY_COMPARE_ERROR_CODES) expect(COMPARE_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
  });
});
