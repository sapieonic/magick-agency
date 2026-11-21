import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import { MetricBars, TrendChart, type ChartAgent } from '../../components/agency/compare/CompareCharts';
import { CompareNumbers } from '../../components/agency/compare/CompareNumbers';
import { CompareFindings } from '../../components/agency/compare/CompareFindings';
import { CODES } from '../helpers/compare';
import { ONE_DAY_COLLECTIONS, THREE_DAYS_COLLECTIONS, THREE_DAYS_SALES } from '../helpers/compareRecorded';

/**
 * Compare agents' charts, table and findings drawn from answers the real server sent in the first
 * end-to-end run (`helpers/compareRecorded.ts`): call-backs kept with none due, a picked agent
 * under the floor beside the team median, a trend line that stops early, and a one-day window
 * where only breaks could be judged.
 */

function agentsOf(response: AgencyCompareResponse): ChartAgent[] {
  return response.agents.map((a, slot) => ({ id: a.agent_user_id, name: a.agent_name ?? '', slot }));
}

function bars(response: AgencyCompareResponse, metricId: string) {
  const info = response.metrics.find((m) => m.id === metricId)!;
  render(<MetricBars info={info} agents={agentsOf(response)} columns={response.agents} cohort={response.cohort.per_metric[metricId]} />);
  return screen.getByTestId('compare-metric');
}

describe('call-backs kept on time with none due', () => {
  it('says "None due yet" in the chart, never "Too few (0 of 8)"', () => {
    const chart = bars(THREE_DAYS_SALES, 'callbacks_kept_rate');
    const rows = within(chart).getAllByTestId('compare-bar-row');
    // agent 0.0 and 0.1 had 0 of 0 due; agent 0.2 had 1 of 2.
    expect(rows.map((r) => r.querySelector('text:nth-of-type(2)')?.textContent)).toEqual([
      'None due yet',
      'None due yet',
      // At the unmeasured width (320px) the short form is drawn.
      'Too few (2 of 8)',
    ]);
    expect(chart.textContent).not.toMatch(/0 of 8|0 call-backs due/);
    expect(chart.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Call-backs kept on time: agent 0.0 none due yet, agent 0.1 none due yet, agent 0.2 too few to compare.',
    );
  });

  it('says "None due yet" in The numbers, never a dash', () => {
    render(<CompareNumbers response={THREE_DAYS_SALES} agents={agentsOf(THREE_DAYS_SALES)} />);
    const row = screen.getByRole('rowheader', { name: 'Call-backs kept on time' }).closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['None due yet', 'None due yet', 'too few2 of 8 needed', '–']);
  });
});

describe('the team median beside a row of words', () => {
  it('stops the median line and band above "Too few to compare", so they never cross its text', () => {
    // Recorded: Will pay for agent 0.0 and 0.6 (14%), agent 0.7 has 5 calls.
    const chart = bars(THREE_DAYS_COLLECTIONS, 'outcomes:higher:will_pay');
    const words = within(chart)
      .getAllByTestId('compare-bar-row')
      .find((r) => r.getAttribute('data-kind') === 'withheld')!;
    const text = words.querySelector('text:nth-of-type(2)')!;
    expect(text.textContent).toBe('Too few (5 of 20)');
    const textTop = Number(text.getAttribute('y')) - 12;
    const lines = chart.querySelectorAll('[data-testid="compare-team-span"] line');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(Number(line.getAttribute('y2'))).toBeLessThan(textTop);
  });

  it('draws no band across a count of all zeros (recorded breaks over their limit)', () => {
    const chart = bars(THREE_DAYS_COLLECTIONS, 'breaks_over_limit');
    const svg = chart.querySelector('svg')!;
    const band = svg.querySelector('[data-testid="compare-team-span"] rect');
    // The team's p75 is a quarter of a break: a sliver of a whole-count scale, not the whole plot.
    const plot = Number(svg.getAttribute('width')) - 96 - 58;
    expect(Number(band?.getAttribute('width') ?? 0)).toBeLessThan(plot * 0.1);
  });
});

describe('the trend’s end labels', () => {
  it('names each agent as the bars do, beside the line’s own last point', () => {
    const r = THREE_DAYS_COLLECTIONS;
    render(<TrendChart trend={r.trend!} agents={agentsOf(r)} label="Will pay" />);
    const ends = screen.getAllByTestId('compare-trend-end');
    const byText = new Map(ends.map((e) => [e.textContent, Number(e.getAttribute('x'))]));
    expect([...byText.keys()].sort()).toEqual(['Team · 2', 'agent 0.0 · 2', 'agent 0.6 · 2', 'agent 0.7 · 1']);
    // agent 0.7 logged in on the first day only: labelled there, left of the others.
    expect(byText.get('agent 0.7 · 1')!).toBeLessThan(byText.get('agent 0.0 · 2')!);
    expect(byText.get('agent 0.0 · 2')).toBe(byText.get('agent 0.6 · 2'));
  });
});

describe('a one-day window where only breaks could be judged', () => {
  it('says which metrics are not judged yet and offers a longer window', () => {
    let longer = 0;
    render(
      <MemoryRouter>
        <CompareFindings response={ONE_DAY_COLLECTIONS} codes={CODES} timezone="Asia/Kolkata" canListen onLonger={() => (longer += 1)} />
      </MemoryRouter>,
    );
    const empty = screen.getByTestId('compare-findings-empty');
    expect(empty.textContent).toMatch(/^Nothing clear stands out on breaks over their limit\. Will pay, time to choose outcome and no outcome chosen are not judged yet/);
    fireEvent.click(within(empty).getByRole('button', { name: 'Check a longer window' }));
    expect(longer).toBe(1);
  });
});
