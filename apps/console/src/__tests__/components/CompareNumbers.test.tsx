import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { AgencyCompareResponse, AgencyCompareValue } from '@magick-agency/contracts/api/agency/compare';
import { CompareNumbers } from '../../components/agency/compare/CompareNumbers';
import type { ChartAgent } from '../../components/agency/compare/CompareCharts';
import { compareResponse, metricInfo, value } from '../helpers/compare';

/**
 * The numbers table words a withheld figure by the server's reason (`withheld`), the reason the
 * chart words too: never a dash for a figure the server withheld, whatever its value.
 */

const promises = metricInfo({ kind: 'builtin', key: 'promises_rate' });
const perHour = metricInfo({ kind: 'builtin', key: 'calls_per_hour' });
const kept = metricInfo({ kind: 'builtin', key: 'callbacks_kept_rate' });

function answer(values: Record<string, AgencyCompareValue>): AgencyCompareResponse {
  const base = compareResponse();
  return {
    ...base,
    metrics: [promises, perHour, kept],
    agents: [{ ...base.agents[0]!, values }],
    cohort: { agents: 9, per_metric: {} },
  };
}

const AGENTS: ChartAgent[] = [{ id: 'u-lak', name: 'Lakshmi P', slot: 0 }];
const LABELS: Record<string, string> = { [promises.id]: 'Promises', [perHour.id]: 'Calls per hour', [kept.id]: 'Call-backs kept on time' };

function cells(response: AgencyCompareResponse) {
  render(<CompareNumbers response={response} agents={AGENTS} />);
  return response.metrics.map((m) => {
    const row = screen.getByRole('rowheader', { name: LABELS[m.id] }).closest('tr')!;
    return within(row).getAllByRole('cell')[0]!.textContent;
  });
}

describe('The numbers, a withheld figure', () => {
  it('says each reason the server gave, never a dash', () => {
    const got = cells(answer({
      [promises.id]: value({ value: null, numerator: 0, denominator: 12, reportable: false, interval: null, withheld: 'too_few' }),
      [perHour.id]: value({ value: null, numerator: 4, denominator: 0, reportable: false, interval: null, withheld: 'no_logged_in_time' }),
      [kept.id]: value({ value: null, numerator: 0, denominator: 0, reportable: false, interval: null, withheld: 'none_due' }),
    }));
    expect(got).toEqual(['too few12 of 20 needed', 'No logged-in time', 'None due yet']);
  });

  it('a figure whose counts disagree is "not shown" with why, under the floor or not', () => {
    const got = cells(answer({
      [promises.id]: value({ value: null, numerator: 52, denominator: 12, reportable: false, interval: null, withheld: 'counts_disagree' }),
      [perHour.id]: value({ value: null, numerator: 60, denominator: 5400, reportable: false, interval: null, withheld: 'counts_disagree' }),
      [kept.id]: value({ value: 0.5, numerator: 1, denominator: 2, reportable: false, interval: [0.1, 0.9], withheld: 'too_few' }),
    }));
    expect(got).toEqual(['not showncounts don’t agree', 'not showncounts don’t agree', 'too few2 of 8 needed']);
  });
});
