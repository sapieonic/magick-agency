import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_OUTCOME_SET_DEFINITION,
  compareMetricId,
  type AgencyCompareAgent,
  type AgencyCompareFinding,
  type AgencyCompareMetricInfo,
  type AgencyCompareMetricRef,
  type AgencyCompareOptions,
  type AgencyCompareOutcomeCode,
  type AgencyCompareResponse,
  type AgencyCompareValue,
  type AgencyCompareView,
} from '@magick-agency/contracts/api/agency/compare';

/** Compare agents wire fixtures, shaped as the contract (`packages/contracts/src/api/agency/compare.ts`). */

export const CODES: AgencyCompareOutcomeCode[] = [
  { code: 'will_pay', label: 'Will pay', is_success: true, requires_promise: true },
  { code: 'part_paid', label: 'Part paid', is_success: true, requires_promise: true },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
  { code: 'call_back', label: 'Call back', is_success: false, requires_promise: false },
  { code: 'wrong_number', label: 'Wrong number', is_success: false, requires_promise: false },
  { code: 'not_interested', label: 'Not interested', is_success: false, requires_promise: false },
];

/** A catalog with no promise codes (a sales campaign). */
export const SALES_CODES: AgencyCompareOutcomeCode[] = [
  { code: 'sale', label: 'Sale', is_success: true, requires_promise: false },
  { code: 'refused', label: 'Refused', is_success: false, requires_promise: false },
];

export const WILL_PAY: AgencyCompareMetricRef = { kind: 'outcomes', codes: ['will_pay', 'part_paid'], better: 'higher', label: 'Will pay' };
export const REFUSED_LOWER: AgencyCompareMetricRef = { kind: 'outcomes', codes: ['refused'], better: 'lower' };

export function compareOptions(over: Partial<AgencyCompareOptions> = {}): AgencyCompareOptions {
  return {
    campaign_id: 'camp-1',
    campaign_name: 'Nov dues',
    agents: [
      { agent_user_id: 'u-lak', name: 'Lakshmi P', calls: 51, reportable: true, active: true },
      { agent_user_id: 'u-ravi', name: 'Ravi Kumar', calls: 42, reportable: true, active: true },
      { agent_user_id: 'u-priya', name: 'Priya M', calls: 29, reportable: true, active: true },
      { agent_user_id: 'u-arjun', name: 'Arjun T', calls: 33, reportable: true, active: false },
      { agent_user_id: 'u-divya', name: 'Divya S', calls: 12, reportable: false, active: true },
      { agent_user_id: 'u-kiran', name: null, calls: 25, reportable: true, active: true },
    ],
    outcome_codes: CODES,
    records_promises: true,
    starting_lens: 'collections',
    default_view: null,
    ...over,
  };
}

export function metricInfo(ref: AgencyCompareMetricRef, label: string | null = null): AgencyCompareMetricInfo {
  const definition = ref.kind === 'builtin' ? COMPARE_BUILTIN_METRICS[ref.key] : { ...COMPARE_OUTCOME_SET_DEFINITION, better: ref.better };
  return {
    id: compareMetricId(ref),
    ref,
    label: ref.kind === 'outcomes' ? (label ?? ref.label ?? ref.codes.join(', ')) : null,
    definition,
    flaggable: definition.better !== 'neutral',
  };
}

export function value(over: Partial<AgencyCompareValue> = {}): AgencyCompareValue {
  return { value: 0.31, numerator: 16, denominator: 51, reportable: true, interval: [0.2, 0.45], ...over };
}

export function finding(over: Partial<AgencyCompareFinding> & Pick<AgencyCompareFinding, 'code' | 'metric'>): AgencyCompareFinding {
  return {
    agent_user_id: 'u-priya',
    value: 0.17,
    baseline: 0.28,
    interval: [0.08, 0.35],
    ratio: null,
    count: 29,
    next_step: null,
    ...over,
  };
}

function agentColumn(id: string, name: string | null, values: Record<string, AgencyCompareValue>): AgencyCompareAgent {
  return {
    agent_user_id: id,
    agent_name: name,
    values,
    day_split: { on_call: 7560, choosing: 1260, break: 1800, waiting: 8280, shift_seconds: 18900 },
  };
}

/** An answer for Lakshmi, Ravi and Priya on calls handled, will pay and time to choose, with a trend. */
export function compareResponse(over: Partial<AgencyCompareResponse> = {}): AgencyCompareResponse {
  const calls = metricInfo({ kind: 'builtin', key: 'calls_handled' });
  const willPay = metricInfo(WILL_PAY);
  const choose = metricInfo({ kind: 'builtin', key: 'choose_time' });
  const v = (calls_: number, wp: [number, number], ch: [number, number]): Record<string, AgencyCompareValue> => ({
    [calls.id]: value({ value: calls_, numerator: calls_, denominator: null, interval: null }),
    [willPay.id]: value({ value: wp[0] / wp[1], numerator: wp[0], denominator: wp[1], reportable: wp[1] >= 20, interval: [0.1, 0.4] }),
    [choose.id]: value({ value: ch[0] / ch[1], numerator: ch[0], denominator: ch[1], reportable: ch[1] >= 20, interval: null }),
  });
  return {
    campaign_id: 'camp-1',
    from: '2026-11-15',
    to: '2026-11-21',
    timezone: 'Asia/Kolkata',
    as_of: '2026-11-21T09:30:00.000Z',
    metrics: [calls, willPay, choose],
    trend_metric: willPay,
    agents: [
      agentColumn('u-lak', 'Lakshmi P', v(51, [16, 51], [714, 51])),
      agentColumn('u-ravi', 'Ravi Kumar', v(42, [12, 42], [756, 42])),
      agentColumn('u-priya', 'Priya M', v(29, [5, 29], [1015, 29])),
    ],
    cohort: {
      agents: 9,
      per_metric: {
        [calls.id]: { p25: 30, median: 40, p75: 46, pooled: null, agents_rated: 9 },
        [willPay.id]: { p25: 0.22, median: 0.28, p75: 0.3, pooled: 0.27, agents_rated: 8 },
        [choose.id]: { p25: 15, median: 19, p75: 22, pooled: 20, agents_rated: 8 },
      },
    },
    findings: [
      finding({ code: 'clear_gap', metric: willPay.id, next_step: 'listen_recent' }),
      finding({ code: 'clear_gap', metric: choose.id, value: 35, baseline: 19, interval: null, ratio: 35 / 19, count: 29, next_step: 'message_outcome_tip' }),
    ],
    not_clear: [],
    trend: {
      metric: willPay.id,
      dates: ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'],
      agents: [
        { agent_user_id: 'u-lak', counts: [2, 3, 2, null, 4, 3, 2] },
        { agent_user_id: 'u-ravi', counts: [1, 2, 2, 3, 1, 2, 1] },
        { agent_user_id: 'u-priya', counts: [null, 1, 0, 1, 1, 1, 1] },
      ],
      cohort_median: [1.5, 2, 2, 2, 1, 2, 1],
    },
    ...over,
  };
}

export function compareView(over: Partial<AgencyCompareView> = {}): AgencyCompareView {
  return {
    id: 'view-1',
    name: 'Collections weekly',
    lens: 'collections',
    metrics: [{ kind: 'builtin', key: 'calls_handled' }, WILL_PAY],
    trend: WILL_PAY,
    campaign_id: 'camp-1',
    shared: false,
    is_campaign_default: false,
    owner: { user_id: 'sup-1', name: 'Anitha N' },
    created_at: '2026-11-20T04:00:00.000Z',
    updated_at: '2026-11-20T04:00:00.000Z',
    ...over,
  };
}
