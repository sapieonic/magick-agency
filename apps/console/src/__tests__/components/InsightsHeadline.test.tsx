import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { InsightsHeadline } from '../../pages/agency/campaign-detail/insights/InsightsHeadline';
import type { AgencyInsightsReadiness, AgencyInsightsSummary } from '../../types/agency-insights';
import type { AgencyCampaignStatus } from '../../types/agency';
import { readiness, summary } from '../helpers/insights';

/**
 * The status-aware headline: one component per status, each reading its own
 * member of `summary.headline`. Times are in the campaign zone (Asia/Kolkata).
 */

const NOW = new Date('2026-11-04T10:12:00.000Z');

function resource(data: AgencyInsightsReadiness | null, error: string | null = null): AsyncResource<AgencyInsightsReadiness | null> {
  return { data, loading: data === null && error === null, error, reload: vi.fn(async () => {}) };
}

function renderHeadline(
  s: AgencyInsightsSummary,
  { canRetry = true, onRetry = vi.fn(), ready = resource(readiness()), staffed = 6 as number | null } = {},
) {
  render(
    <MemoryRouter>
      <InsightsHeadline summary={s} readiness={ready} now={NOW} canRetry={canRetry} onRetry={onRetry} staffedAgents={staffed} />
    </MemoryRouter>,
  );
  return { onRetry };
}

const kpi = (id: string) => screen.getByTestId(id).textContent ?? '';

afterEach(cleanup);

describe('draft: the launch checklist', () => {
  it('lists every check with its result, and a Fix link to the right screen for each that does not pass', () => {
    renderHeadline(summary('draft'));
    const panel = screen.getByTestId('headline-draft');
    expect(within(panel).getByRole('heading', { name: 'Ready to launch?' })).toBeTruthy();
    expect(panel.textContent).toContain('5 of 9 checks pass');

    const roster = screen.getByTestId('readiness-roster_uploaded');
    expect(roster.getAttribute('data-result')).toBe('pass');
    expect(within(roster).queryByRole('link')).toBeNull();

    const hours = screen.getByTestId('readiness-calling_hours_set');
    expect(hours.getAttribute('data-result')).toBe('warn');
    expect(within(hours).getByRole('link', { name: 'Fix: Calling hours' }).getAttribute('href')).toBe('/agency/campaigns/camp-1/settings');

    const allocated = screen.getByTestId('readiness-contacts_allocated');
    expect(allocated.getAttribute('data-result')).toBe('fail');
    expect(allocated.textContent).toContain('Strict mode: 1,410 unassigned will never be dialled');
    expect(within(allocated).getByRole('link').getAttribute('href')).toBe('/agency/campaigns/camp-1/agents');

    expect(panel.textContent).toContain('Fix the failed checks before starting this campaign.');
  });

  it('says it is ready when nothing fails, warnings included', () => {
    const passing = readiness({
      ready: true,
      checks: readiness().checks.map((c) => (c.result === 'fail' ? { ...c, result: 'pass' as const } : c)),
    });
    renderHeadline(summary('draft'), { ready: resource(passing) });
    expect(screen.getByTestId('headline-draft').textContent).toContain('Ready to start. Warnings do not block a launch.');
  });

  it('shows the checklist’s own error rather than an empty list', () => {
    renderHeadline(summary('draft'), { ready: resource(null, 'Could not load the launch checklist.') });
    expect(screen.getByRole('alert').textContent).toBe('Could not load the launch checklist.');
  });
});

describe('running: live now', () => {
  it('reads out the floor, the line, the pace and the time to finish', () => {
    renderHeadline(summary('running'));
    expect(kpi('kpi-agents-online')).toContain('4 of 6');
    expect(kpi('kpi-agents-online')).toContain('3 on a call · 1 in wrap-up · 0 on break');
    expect(kpi('kpi-calls-live')).toContain('Concurrency 3 of 40');
    expect(kpi('kpi-dial-pace')).toContain('412 / h');
    expect(kpi('kpi-eta')).toContain('≈ 3d 1h');
    expect(screen.getByTestId('headline-running').textContent).toContain('Running for 4d 6h');
  });

  it('says nothing is holding dials back, and the abandonment against its ceiling', () => {
    renderHeadline(summary('running'));
    expect(screen.getByTestId('headline-stall').textContent).toContain('Dialling normally.');
    expect(screen.getByTestId('headline-abandonment').textContent).toContain('2.1%');
    expect(screen.getByTestId('headline-abandonment').textContent).toContain('3% ceiling');
  });

  it.each([
    { abandoned: 23, tone: undefined }, // 2.3%: under 80% of the 3% ceiling
    { abandoned: 24, tone: 'warn' }, // 2.4%: exactly 80% of it
    { abandoned: 30, tone: 'warn' }, // 3.0%: AT the ceiling, which the guardrail does not pause on
    { abandoned: 31, tone: 'bad' }, // 3.1%: above it, which it does
  ])('tones $abandoned abandoned of 1,000 answered, against a 3% ceiling, as $tone', ({ abandoned, tone }) => {
    const s = summary('running');
    s.headline.running = { ...s.headline.running!, abandonment_rate_24h: { abandoned, answered: 1000 } };
    renderHeadline(s);
    expect(screen.getByTestId('headline-abandonment').getAttribute('data-tone')).toBe(tone ?? null);
  });

  it('names the stall when there is one, and withholds a rate built on too few calls', () => {
    const s = summary('running');
    s.headline.running = {
      ...s.headline.running!,
      stall: { code: 'no_agents_available', agents_on_shift: 4, on_break_by_reason: { lunch: 4 }, on_call: 0, last_dial_at: null },
      other_stalls: ['outside_calling_hours'],
      dials_per_hour: null,
      eta_seconds: null,
      abandonment_rate_24h: { abandoned: 1, answered: 10 },
    };
    renderHeadline(s);
    expect(screen.getByTestId('headline-stall').getAttribute('data-tone')).toBe('warn');
    expect(screen.getByTestId('headline-running').textContent).toContain('Also: Outside calling hours');
    expect(kpi('kpi-dial-pace')).toContain('No dials yet');
    expect(kpi('kpi-eta')).toContain('Not known yet');
    expect(screen.getByTestId('headline-abandonment').textContent).toContain('Not enough calls yet');
  });

  it('draws the progress bar to scale', () => {
    renderHeadline(summary('running'));
    const bar = screen.getByTestId('roster-progress');
    const widths = Array.from(bar.querySelectorAll('[style]')).map((el) => (el as HTMLElement).style.width);
    expect(widths).toEqual(['40%', '8%', '6.5%']);
    expect(bar.textContent).toContain('54.5% of contacts finished');
  });
});

describe('paused', () => {
  it('names who paused it, for how long, and what is waiting', () => {
    renderHeadline(summary('paused'));
    const panel = screen.getByTestId('headline-paused');
    expect(panel.textContent).toContain('Paused for 1h 37m');
    expect(kpi('kpi-paused-by')).toContain('Anita Kulkarni');
    expect(kpi('kpi-paused-by')).toContain('Supervisor pause, 4 Nov, 14:05');
    expect(kpi('kpi-calls-finishing')).toContain('1');
    expect(within(screen.getByTestId('kpi-waiting-to-resume')).getByRole('link').getAttribute('href'))
      .toBe('/agency/campaigns/camp-1/contacts?state=pending&waiting=due_now');
    expect(kpi('kpi-callbacks-missed')).toContain('52 more fall due');
    expect(panel.textContent).toContain('37 callbacks have fallen due since the pause.');
  });

  it('says the guardrail paused it, at the rate it measured', () => {
    const s = summary('paused');
    s.headline.paused = { ...s.headline.paused!, reason: 'abandonment_ceiling', actor: null, abandonment_rate_pct_at_pause: 3.4, callbacks_missed_while_paused: 0 };
    renderHeadline(s);
    expect(kpi('kpi-paused-by')).toContain('The abandonment guardrail');
    expect(kpi('kpi-paused-by')).toContain('Abandonment reached 3.4% (ceiling 3%)');
    expect(screen.getByTestId('headline-paused').textContent).not.toContain('fallen due since the pause');
  });

  it('says the carrier refused the account’s credentials, and who can fix it', () => {
    const s = summary('paused');
    s.headline.paused = { ...s.headline.paused!, reason: 'carrier_auth', actor: null, abandonment_rate_pct_at_pause: null, callbacks_missed_while_paused: 0 };
    renderHeadline(s);
    expect(kpi('kpi-paused-by')).toContain('The carrier');
    expect(kpi('kpi-paused-by')).toContain('Paused: the carrier refused this account’s credentials. Ask your administrator to check them.');
    expect(kpi('kpi-paused-by')).not.toContain('Supervisor pause');
  });
});

describe('stopping', () => {
  it('names who pressed stop and how many calls are finishing', () => {
    renderHeadline(summary('stopping'));
    expect(kpi('kpi-stopped-by')).toContain('Anita Kulkarni');
    expect(kpi('kpi-stopped-by')).toContain('4 Nov, 15:40');
    expect(kpi('kpi-calls-finishing')).toContain('2');
  });
});

describe('stopped', () => {
  it('says what was left, with links into the roster', () => {
    renderHeadline(summary('stopped'));
    expect(kpi('kpi-pending')).toContain('450');
    expect(within(screen.getByTestId('kpi-never-attempted')).getByRole('link').getAttribute('href'))
      .toBe('/agency/campaigns/camp-1/contacts?attempted=0');
    expect(kpi('kpi-never-attempted')).toContain('38% of the roster');
    expect(kpi('kpi-retry-matched')).toContain('520');
  });

  it('opens the retry dialog from "Create retry campaign (N)"', () => {
    const { onRetry } = renderHeadline(summary('stopped'));
    fireEvent.click(screen.getByRole('button', { name: 'Create retry campaign (520)' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry to a role that cannot create one, or when nothing would be picked up', () => {
    renderHeadline(summary('stopped'), { canRetry: false });
    expect(screen.queryByTestId('insights-retry')).toBeNull();
    cleanup();
    const s = summary('stopped');
    s.headline.stopped = { ...s.headline.stopped!, retry_matched: 0 };
    renderHeadline(s);
    expect(screen.queryByTestId('insights-retry')).toBeNull();
  });
});

describe('completed', () => {
  it('gives the final summary', () => {
    renderHeadline(summary('completed'));
    expect(kpi('kpi-duration')).toContain('8d 8h');
    expect(kpi('kpi-reached')).toContain('661');
    expect(kpi('kpi-reached')).toContain('66.1% of the roster');
    expect(kpi('kpi-successes')).toContain('30.3% of contacts reached');
    expect(kpi('kpi-not-reached')).toContain('214 a retry could pick up');
    expect(screen.getByRole('button', { name: 'Create retry campaign (214)' })).toBeTruthy();
  });
});

describe('exactly one headline per status', () => {
  it.each(['draft', 'running', 'paused', 'stopping', 'stopped', 'completed'] as AgencyCampaignStatus[])('%s renders its own', (status) => {
    renderHeadline(summary(status));
    expect(screen.getAllByTestId(/^headline-(draft|running|paused|stopping|stopped|completed)$/)).toHaveLength(1);
    expect(screen.getByTestId(`headline-${status}`)).toBeTruthy();
  });
});
