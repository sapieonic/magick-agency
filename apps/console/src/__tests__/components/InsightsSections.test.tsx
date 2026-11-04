import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { activity, allocation, health, roster, summary, trends, uploads, ZONE } from '../helpers/insights';

/**
 * Each Insights section against a reconciling sample (`helpers/insights.ts`):
 * what it reads out, that it is drawn to scale, that every number opens the
 * matching filtered list, and that its CSV is the rows it shows.
 */

const mocks = vi.hoisted(() => ({
  downloadCsv: vi.fn(),
  downloadRejectedRows: vi.fn(),
  showErrorToast: vi.fn(),
}));
vi.mock('../../utils/agency/insights/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/agency/insights/csv')>()),
  downloadCsv: mocks.downloadCsv,
}));
vi.mock('../../api/agencyCampaigns', () => ({ downloadRejectedRows: mocks.downloadRejectedRows }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: mocks.showErrorToast }),
}));

import { RosterSection } from '../../pages/agency/campaign-detail/insights/RosterSection';
import { reconciliationLabel } from '../../pages/agency/campaign-detail/insights/InsightsParts';
import { AllocationSection } from '../../pages/agency/campaign-detail/insights/AllocationSection';
import {
  CallbacksSection,
  CallsSection,
  OverridesSection,
  outcomeLines,
  type RangeSectionContext,
} from '../../pages/agency/campaign-detail/insights/ActivitySections';
import { AgentsSection } from '../../pages/agency/campaign-detail/insights/AgentsSection';
import { TrendsSection, bestHour } from '../../pages/agency/campaign-detail/insights/TrendsSection';
import { HealthSection, RecordingSection } from '../../pages/agency/campaign-detail/insights/HealthSection';
import { UploadsSection } from '../../pages/agency/campaign-detail/insights/UploadsSection';

const NAMES: Record<string, string> = { usr_priya: 'Priya Nair', usr_vikram: 'Vikram Rao', usr_meera: 'Meera Iyer' };
const ctx: RangeSectionContext = {
  campaignId: 'camp-1',
  campaignName: 'EMI Recovery',
  range: { from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T10:12:00.000Z' },
  rangeLabel: 'Today',
  agentName: (id) => (id === null ? 'Unassigned' : NAMES[id] ?? 'Unknown agent'),
};
// Every attempts link lists placed dials, the range half-open on dialed_at (links.ts).
const RANGE_QS = 'placed=1&dialed_from=2026-11-03T18%3A30%3A00.000Z&dialed_to=2026-11-04T10%3A12%3A00.000Z';

function show(node: ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/** The text of the CSV the n-th "… CSV" button on screen would download. */
function csvOf(name: RegExp | string): string {
  fireEvent.click(screen.getByRole('button', { name }));
  const call = mocks.downloadCsv.mock.calls.at(-1);
  return call?.[1] as string;
}

function hrefOf(scope: HTMLElement, name: string | RegExp): string | null {
  return within(scope).getByRole('link', { name }).getAttribute('href');
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('roster and progress', () => {
  it('reads penetration, completion and attempts per contact from the counts', () => {
    show(<RosterSection campaignId="camp-1" campaignName="EMI Recovery" roster={roster()} />);
    expect(screen.getByTestId('kpi-penetration').textContent).toContain('62%');
    expect(screen.getByTestId('kpi-completion').textContent).toContain('40%');
    expect(screen.getByTestId('kpi-attempts-per-contact').textContent).toContain('2.0');
    expect(screen.getByTestId('kpi-attempts-per-contact').textContent).toContain('1: 48.4% · 2: 29% · 3: 14.5% · 4+: 8.1%');
  });

  it('draws the funnel to scale and links each state to its contacts', () => {
    show(<RosterSection campaignId="camp-1" campaignName="EMI Recovery" roster={roster()} />);
    const due = screen.getByTestId('funnel-waiting_due_now');
    expect((due.querySelector('[style]') as HTMLElement).style.width).toBe('30%');
    expect(hrefOf(due, /300 contacts: Due now/)).toBe('/agency/campaigns/camp-1/contacts?state=pending&waiting=due_now');
    expect(hrefOf(screen.getByTestId('funnel-in_wrapup'), /In wrap-up/)).toBe('/agency/campaigns/camp-1/contacts?state=connected');
    expect(hrefOf(screen.getByTestId('funnel-suppressed_dnc'), /Do Not Call/)).toBe('/agency/campaigns/camp-1/contacts?state=suppressed&suppressed_reason=dnc');
  });

  it('shows the server’s reconciliation as a fact, and a failed one as a failure', () => {
    const r = roster({ reconciliation: [{ check: 'contact_states_vs_total', expected: 1000, actual: 998, ok: false }] });
    show(<RosterSection campaignId="camp-1" campaignName="EMI Recovery" roster={r} />);
    const chip = within(screen.getByTestId('reconciliation')).getByText(/States add up/);
    expect(chip.getAttribute('data-ok')).toBe('false');
    expect(chip.textContent).toContain('998 of 1,000');
  });

  it('labels every reconciliation the server sends (docs/insights.md "API")', () => {
    expect(reconciliationLabel('contact_states_vs_total')).toBe('States add up to the roster');
    expect(reconciliationLabel('attempts_per_contact_vs_attempted')).toBe('Attempts per contact add up to the attempted');
    expect(reconciliationLabel('waiting_vs_pending')).toBe('Waiting adds up to the pending contacts');
    expect(reconciliationLabel('allocated_plus_unassigned_vs_total')).toBe('Allocated and unassigned add up to the roster');
    expect(reconciliationLabel('agent_buckets_vs_allocated')).toBe('Each agent’s states add up to their allocation');
  });

  it('exports the funnel with raw numbers', () => {
    show(<RosterSection campaignId="camp-1" campaignName="EMI Recovery" roster={roster()} />);
    const csv = csvOf('Download CSV');
    expect(mocks.downloadCsv.mock.calls[0]?.[0]).toBe('insights-roster-EMI Recovery.csv');
    expect(csv.split('\r\n')[0]).toBe('State,Part of,Contacts');
    expect(csv).toContain('Due now,Waiting,300\r\n');
    expect(csv).toContain('Total,,1000\r\n');
  });
});

describe('allocation', () => {
  function renderAllocation(over = {}) {
    return show(<AllocationSection campaignId="camp-1" campaignName="EMI Recovery" allocation={allocation(over)} timezone={ZONE} />);
  }

  it('has a row per agent, then Unassigned and Total, as table semantics', () => {
    renderAllocation();
    const table = screen.getByTestId('allocation-table');
    const rows = within(table).getAllByRole('row');
    expect(rows.map((r) => within(r).queryAllByRole('rowheader')[0]?.textContent ?? 'header')).toEqual([
      'header',
      'Priya Nairbacklog 1.5×',
      'Vikram Rao',
      'Unassigned',
      'Total',
    ]);
    expect(within(table).getAllByRole('columnheader')[0]?.textContent).toBe('Agent');
  });

  it('links each count to that owner’s contacts, the pool to unassigned, and redials to attempts', () => {
    renderAllocation();
    const table = screen.getByTestId('allocation-table');
    const [, priya, , pool] = within(table).getAllByRole('row');
    expect(hrefOf(priya!, '120 due now')).toBe('/agency/campaigns/camp-1/contacts?state=pending&waiting=due_now&assigned_to=usr_priya');
    expect(hrefOf(priya!, '12 redials')).toBe('/agency/campaigns/camp-1/attempts?agent_user_id=usr_priya&redial=1&placed=1');
    expect(hrefOf(pool!, '200 allocated')).toBe('/agency/campaigns/camp-1/contacts?assigned_to=unassigned');
  });

  it('sorts by a column, keeping Unassigned and Total at the foot', () => {
    renderAllocation();
    const table = screen.getByTestId('allocation-table');
    fireEvent.click(within(table).getByRole('button', { name: 'Successes' }));
    const names = () => within(table).getAllByRole('rowheader').map((c) => c.textContent);
    expect(names()).toEqual(['Priya Nairbacklog 1.5×', 'Vikram Rao', 'Unassigned', 'Total']);
    expect(within(table).getByRole('columnheader', { name: /Successes/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(within(table).getByRole('button', { name: /Successes/ }));
    expect(names()).toEqual(['Vikram Rao', 'Priya Nairbacklog 1.5×', 'Unassigned', 'Total']);
  });

  it('calls out the at-risk backlog, the imbalance and the last bulk change', () => {
    renderAllocation();
    expect(screen.getByTestId('allocation-at-risk').textContent).toContain('60 due contacts held by Vikram Rao');
    expect(screen.getByTestId('allocation-imbalance').textContent).toContain('Priya Nair’s due queue is 1.5× the staffed average.');
    expect(screen.getByText(/Last bulk change/).parentElement?.textContent).toContain('Rebalance, 600 contacts, by Anita Kulkarni');
    expect(screen.getByTestId('allocation-history')).toBeTruthy();
  });

  it('exports the agents, then the Unassigned and Total rows', () => {
    renderAllocation();
    const lines = csvOf('Download CSV').trim().split('\r\n');
    expect(lines[0]?.startsWith('Agent,Allocated,Attempted,Not yet,Due now')).toBe(true);
    expect(lines.map((l) => l.split(',')[0])).toEqual(['Agent', 'Priya Nair', 'Vikram Rao', 'Unassigned', 'Total']);
    expect(lines[4]?.split(',')[1]).toBe('1000');
  });
});

describe('calls and outcomes', () => {
  it('reads dials, connect rate, redials and handle time', () => {
    show(<CallsSection ctx={ctx} activity={activity()} />);
    expect(screen.getByTestId('kpi-connected').textContent).toContain('Connect rate 32.3%');
    expect(screen.getByTestId('kpi-redials').textContent).toContain('29 connected · 3 hit the limit · 1 refused at the limit');
    expect(screen.getByTestId('kpi-aht').textContent).toContain('3m 41s');
    expect(screen.getByTestId('kpi-softphone').textContent).toContain('7');
  });

  it('lists every outcome, summing to the dials, each linked to its attempts in range', () => {
    const a = activity();
    expect(outcomeLines(a).reduce((s, l) => s + l.count, 0)).toBe(a.calls.dials);
    show(<CallsSection ctx={ctx} activity={a} />);
    const table = screen.getByTestId('outcomes-table');
    expect(hrefOf(table, /dials: No answer/)).toBe(`/agency/campaigns/camp-1/attempts?outcome=no_answer&${RANGE_QS}`);
    expect(within(table).getByText('Stopped by us before answer')).toBeTruthy();
    expect(within(table).getByText('Still live or not yet recorded')).toBeTruthy();
  });

  it('marks the successful dispositions and links each to its attempts', () => {
    show(<CallsSection ctx={ctx} activity={activity()} />);
    const table = screen.getByTestId('dispositions-table');
    const ptp = within(table).getByText('Promise to pay').closest('tr') as HTMLElement;
    expect(ptp.textContent).toContain('Success');
    expect(ptp.textContent).toContain('37.5%');
    expect(hrefOf(ptp, /written up as Promise to pay/)).toBe(`/agency/campaigns/camp-1/attempts?disposition_code=ptp&${RANGE_QS}`);
    expect(within(table).getByText('Closed with no outcome')).toBeTruthy();
  });

  it('withholds the connect rate below 25 dials', () => {
    const a = activity();
    a.calls = { ...a.calls, dials: 20, connected: 5 };
    show(<CallsSection ctx={ctx} activity={a} />);
    expect(screen.getByTestId('kpi-connected').textContent).toContain('Not enough calls yet');
  });
});

describe('callbacks', () => {
  it('reads on time, late and missed, and the open callbacks by owner', () => {
    show(<CallbacksSection ctx={ctx} activity={activity()} />);
    expect(screen.getByTestId('kpi-callbacks-on-time').textContent).toContain('71.4% of those due');
    expect(screen.getByTestId('kpi-callbacks-missed-range').textContent).toContain('6');
    const table = screen.getByTestId('callbacks-table');
    expect(hrefOf(table, '6 open callbacks')).toBe('/agency/campaigns/camp-1/contacts?state=pending&waiting=callback&assigned_to=unassigned');
    expect(within(table).getByText('Priya Nair')).toBeTruthy();
  });
});

describe('overrides', () => {
  it('lists granted and used per outcome and per agent', () => {
    show(<OverridesSection ctx={ctx} activity={activity()} settings={summary().settings} />);
    const rows = within(screen.getByTestId('overrides-table')).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('Promise to pay');
    expect(rows[1]?.textContent).toContain('All agents');
    expect(rows[2]?.textContent).toContain('Priya Nair');
  });

  it('says why the table is empty', () => {
    show(<OverridesSection ctx={ctx} activity={activity({ overrides: [] })} settings={summary().settings} />);
    expect(screen.getByText('No overrides were granted in this range.')).toBeTruthy();
  });
});

describe('agents', () => {
  it('reads time in states, occupancy and rates, and links the name to the Agents tab', () => {
    show(<AgentsSection ctx={ctx} activity={activity()} />);
    const table = screen.getByTestId('agents-table');
    const priya = within(table).getByRole('link', { name: 'Priya Nair' });
    expect(priya.getAttribute('href')).toBe('/agency/campaigns/camp-1/agents');
    const row = priya.closest('tr') as HTMLElement;
    expect(row.textContent).toContain('60%'); // occupancy (10,000 + 2,000) / 20,000
    expect(row.textContent).toContain('34.3%'); // connect rate 240 / 700
    expect(hrefOf(row, '700 dials')).toBe(`/agency/campaigns/camp-1/attempts?agent_user_id=usr_priya&${RANGE_QS}`);
    expect(screen.getByTestId('never-joined').textContent).toContain('Meera Iyer');
  });

  it('ranks by successes when the leaderboard is on', () => {
    show(<AgentsSection ctx={ctx} activity={activity()} />);
    const names = () => within(screen.getByTestId('agents-table')).getAllByRole('rowheader').map((c) => c.textContent);
    expect(names()).toEqual(['Priya Nair', 'Vikram Rao']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leaderboard' }));
    expect(names()).toEqual(['1. Vikram Rao', '2. Priya Nair']);
  });
});

describe('trends', () => {
  function renderTrends(onBucketChange = vi.fn()) {
    show(
      <TrendsSection
        ctx={ctx}
        trends={trends()}
        bucket="day"
        bucketOptions={['hour', 'day']}
        onBucketChange={onBucketChange}
        timezone={ZONE}
        ceilingPct={3}
      />,
    );
    return onBucketChange;
  }

  it('draws one column per bucket, and breaks the rate line where a bucket has too few calls', () => {
    renderTrends();
    const chart = screen.getByTestId('trend-dials');
    expect(within(chart).getAllByTestId('trend-dials-bucket')).toHaveLength(5);
    // 1 Nov has 10 dials and 2 Nov none: the line is two runs, not one through zero.
    expect(chart.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('draws the abandonment ceiling on the rate axis', () => {
    renderTrends();
    expect(within(screen.getByTestId('trend-abandonment')).getByTestId('chart-reference')).toBeTruthy();
  });

  it('switches bucket width', () => {
    const onBucketChange = renderTrends();
    fireEvent.click(screen.getByRole('button', { name: 'Hour' }));
    expect(onBucketChange).toHaveBeenCalledWith('hour');
    expect(screen.getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('names the best hour among those with enough calls', () => {
    expect(bestHour(trends().best_hours)).toEqual({ hour: 18, rate: 38 });
    renderTrends();
    expect(screen.getByText(/Best hour: 18:00–19:00, 38% connect rate/)).toBeTruthy();
  });

  it('exports every bucket with raw rates', () => {
    renderTrends();
    const lines = csvOf('Trends CSV').trim().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('2026-10-31,300,90,30,40,2,120,1.6666666666666667,4');
    // 1 Nov: 10 dials, so the rate cell is empty, not 30.
    expect(lines[2]).toBe('2026-11-01,10,3,,1,0,4,,1');
  });
});

describe('health and compliance', () => {
  it('reads abandonment against the ceiling, auto-pauses and pre-dial blocks', () => {
    show(<HealthSection ctx={ctx} health={health()} timezone={ZONE} />);
    expect(screen.getByTestId('kpi-health-abandonment').textContent).toContain('2.1%');
    expect(screen.getByTestId('kpi-auto-pauses').textContent).toContain('2 Nov, 11:30 at 3.4%');
    expect(screen.getByTestId('kpi-predial').textContent).toContain('210 held for calling hours');
    expect(hrefOf(screen.getByTestId('kpi-carrier-failures'), '60 failed dials')).toBe(`/agency/campaigns/camp-1/attempts?outcome=failed&${RANGE_QS}`);
  });

  it('lists caller IDs with their connect rate and a link to their dials', () => {
    show(<HealthSection ctx={ctx} health={health()} timezone={ZONE} />);
    const table = screen.getByTestId('caller-ids-table');
    const row = within(table).getByText('+912067124411').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('25%');
    expect(hrefOf(row, /dials from/)).toBe(`/agency/campaigns/camp-1/attempts?caller_id=%2B912067124411&${RANGE_QS}`);
  });

  it('says where pacing history starts, and lists stalls by reason', () => {
    show(<HealthSection ctx={ctx} health={health()} timezone={ZONE} />);
    expect(screen.getByTestId('pacing-history-since').textContent).toBe('Pacing history since 4 Nov, 05:30. Earlier minutes were not recorded.');
    const reasons = within(screen.getByTestId('stall-reasons-table')).getAllByRole('rowheader').map((c) => c.textContent);
    expect(reasons).toEqual(['No agents free', 'At the concurrency limit', 'Outside calling hours']);
  });

  it('reads recording coverage', () => {
    show(<RecordingSection ctx={ctx} health={health()} settings={summary().settings} />);
    expect(screen.getByTestId('kpi-recording').textContent).toContain('99%');
    expect(screen.getByTestId('kpi-analysed').textContent).toContain('Off');
  });
});

describe('upload history', () => {
  it('lists each upload with why rows were rejected, and downloads the rejected rows', async () => {
    mocks.downloadRejectedRows.mockResolvedValue(new Blob(['row_number,_reason\n']));
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    show(<UploadsSection campaignId="camp-1" campaignName="EMI Recovery" uploads={uploads()} timezone={ZONE} tenantId="tenant-1" accountId="account-1" />);
    const table = screen.getByTestId('uploads-table');
    expect(table.textContent).toContain('Invalid phone number 180, No phone number 32');
    expect(table.textContent).toContain('96 on Loan No');
    fireEvent.click(within(table).getByRole('button', { name: /Download the rejected rows/ }));
    await waitFor(() => expect(mocks.downloadRejectedRows).toHaveBeenCalledWith('job-2', 'tenant-1', 'account-1'));
  });

  it('quotes a file name with a comma and quotes in its CSV', () => {
    show(<UploadsSection campaignId="camp-1" campaignName="EMI Recovery" uploads={uploads()} timezone={ZONE} tenantId="tenant-1" accountId="account-1" />);
    expect(csvOf('Download CSV').split('\r\n')[1]?.startsWith('"october, cycle ""B"".csv",Anita Kulkarni,')).toBe(true);
  });
});
