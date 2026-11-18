import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyFloorAgent, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import { board, floorRow, onBoard, stats } from '../helpers/home';

/**
 * Live floor, Phase 2 (B28b): the agent cards from the floor read (ranked, filtered by the chips
 * and the campaign filter, with Listen, Make available and the coming-soon controls), breaks over
 * the limit in Needs you now (left off the sidebar badge), Agents working from the floor, Will pay
 * from the promises summary, and who paused a campaign.
 */

const mocks = vi.hoisted(() => ({
  getAgencyHomeBoard: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  getAgencyFloor: vi.fn(),
  getAgencyPromisesSummary: vi.fn(),
  forceAgentAvailable: vi.fn(),
  listen: vi.fn(),
  canListen: true,
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: 'account_admin', tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune' }] }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyStats', () => ({ getAgencyGroupedStats: mocks.getAgencyGroupedStats }));
vi.mock('../../api/agencyFloor', () => ({
  getAgencyFloor: mocks.getAgencyFloor,
  getAgencyPromisesSummary: mocks.getAgencyPromisesSummary,
}));
vi.mock('../../api/agency', () => ({ forceAgentAvailable: mocks.forceAgentAvailable }));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: vi.fn(), transitionAgencyCampaign: vi.fn() }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ available: false, count: null, inboundOn: true, settled: true }),
}));
vi.mock('../../components/listen/ListenProvider', () => ({
  useListen: () => ({ canListen: mocks.canListen, listen: mocks.listen }),
}));

import HomePage from '../../pages/agency/HomePage';
import { resetHomeAcksForTests } from '../../hooks/useHomeAcks';
import { useHomeBadgeCount } from '../../hooks/useHomeBoard';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function BadgeCount() {
  const { count } = useHomeBadgeCount('t-1', 'a-1', 'account_admin', { available: false, count: null });
  return <div data-testid="shared-count">{String(count)}</div>;
}

function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderHome(entry = '/agency/home') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agency/home" element={<><HomePage /><BadgeCount /><Search /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function floorOf(agents: AgencyFloorAgent[], totals = { on_shift: agents.filter((a) => a.state !== 'offline').length, assigned: agents.length }): AgencyFloorResponse {
  return { agents, totals, as_of: new Date().toISOString() };
}

const CALL = (over: Partial<NonNullable<AgencyFloorAgent['call']>> = {}): NonNullable<AgencyFloorAgent['call']> => ({
  call_id: 'call-1',
  origin: 'campaign',
  correlation_id: 'att-1',
  customer_name: 'Ramesh Goud',
  connected_at: minutesAgo(1),
  aht_seconds: 300,
  listenable: true,
  not_listenable_reason: null,
  ...over,
});

const FLOOR = () => floorOf([
  floorRow('ravi', { agent_name: 'Ravi Kumar', state: 'on_call', state_since: minutesAgo(1), call: CALL(), calls_today: 42, client_kind: 'mobile' }),
  floorRow('priya', { agent_name: 'Priya M', state: 'break', break_label: 'Tea', state_since: minutesAgo(42) }),
  floorRow('divya', { agent_name: 'Divya S', state: 'wrapup', state_since: minutesAgo(5), wrapup_window_seconds: 30 }),
  floorRow('arjun', { agent_name: 'Arjun T', campaign_id: 'c2', campaign_name: 'Gold' }),
  floorRow('naveen', { agent_name: 'Naveen G', session_id: null, campaign_id: null, campaign_name: null, state: 'offline', state_since: null, connected: null, client_kind: null, calls_today: 0 }),
], { on_shift: 4, assigned: 10 });

const SUMMARY = (over: Partial<AgencyPromisesSummaryResponse> = {}): AgencyPromisesSummaryResponse => ({
  campaigns: [
    { campaign_id: 'c1', promises: 71, with_amount: 70, amount_total: '200000.00' },
    { campaign_id: 'c2', promises: 25, with_amount: 25, amount_total: '40000.00' },
  ],
  promise_campaign_ids: ['c1', 'c2'],
  from: '',
  to: '',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHomeAcksForTests();
  mocks.canListen = true;
  mocks.getAgencyHomeBoard.mockResolvedValue(board([
    onBoard('c1', { name: 'Q4 collections', stats: stats({ agents_live: 3 }) }),
    onBoard('c2', {
      name: 'Gold',
      status: 'paused',
      statusChanged: { at: minutesAgo(30), by_user_id: 'u-9', by_name: 'Anitha', automatic: false },
    }),
  ]));
  mocks.getAgencyGroupedStats.mockResolvedValue({
    rows: [{ key: { campaign_id: 'c1' }, attempts: 100, connected: 30, successes: 9, talk_seconds: 600, wrapup_seconds: 0 }],
    total_groups: 1,
  });
  mocks.getAgencyFloor.mockResolvedValue(FLOOR());
  mocks.getAgencyPromisesSummary.mockResolvedValue(SUMMARY());
});
afterEach(() => cleanup());

const cardIds = () => within(screen.getByTestId('home-agent-grid')).getAllByRole('listitem')
  .filter((li) => li.getAttribute('data-testid')?.startsWith('home-agent-'))
  .map((li) => li.getAttribute('data-testid')!.replace('home-agent-', ''));

describe('the agent cards', () => {
  it('rank who needs a look first, then by state, and say what each is doing', async () => {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    // Divya's wrap-up and Priya's break are past their limits; then on a call, ready, offline.
    expect(cardIds()).toEqual(['divya', 'priya', 'ravi', 'arjun', 'naveen']);
    const ravi = screen.getByTestId('home-agent-ravi');
    expect(ravi.textContent).toContain('Ravi Kumar');
    expect(ravi.textContent).toContain('On a call');
    expect(ravi.textContent).toContain('Ramesh Goud');
    expect(ravi.textContent).toMatch(/\d+:\d{2}/);
    expect(ravi.textContent).toContain('42 calls today');
    expect(within(ravi).getByText('Mobile app')).toBeTruthy();
    expect(screen.getByTestId('home-agent-divya').textContent).toContain('Choosing outcome');
    expect(screen.getByTestId('home-agent-risk-divya').textContent).toBe('Wrap-up has run past this campaign’s window.');
    expect(screen.getByTestId('home-agent-priya').textContent).toContain('Tea');
    expect(screen.getByTestId('home-agent-naveen').textContent).toContain('Not signed in today');
    // The chips count the floor's rows.
    expect(screen.getByTestId('home-chip-all').textContent).toBe('All 5');
    expect(screen.getByTestId('home-chip-offline').textContent).toBe('Offline 1');
    expect(screen.getByTestId('home-chip-help').textContent).toBe('Need helpComing soon');
  });

  it('filter by a chip, and by the campaign filter', async () => {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    const chip = screen.getByTestId('home-chip-break');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(cardIds()).toEqual(['priya']);
    fireEvent.click(chip);
    expect(screen.getByTestId('home-chip-all').getAttribute('aria-pressed')).toBe('true');
    expect(cardIds()).toHaveLength(5);

    fireEvent.change(screen.getByRole('combobox', { name: 'Show campaign' }), { target: { value: 'c2' } });
    expect(cardIds()).toEqual(['arjun']);
    expect(screen.getByTestId('home-chip-all').textContent).toBe('All 1');
  });

  it('start a listen as the Live calls list does, with the reason when it cannot, and none for a reader who cannot listen', async () => {
    const floor = FLOOR();
    floor.agents.push(floorRow('kiran', {
      agent_name: 'Kiran J',
      state: 'on_call',
      call: CALL({ call_id: 'call-2', listenable: false, not_listenable_reason: 'listen_recording_off' }),
    }));
    mocks.getAgencyFloor.mockResolvedValue(floor);
    const first = renderHome();
    await screen.findByTestId('home-agent-grid');
    fireEvent.click(within(screen.getByTestId('home-agent-ravi')).getByRole('button', { name: 'Listen to Ravi Kumar’s call' }));
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0]![0]).toMatchObject({ call_id: 'call-1', agent_session_id: 's-ravi', customer_phone_masked: 'Ramesh Goud' });
    const refused = within(screen.getByTestId('home-agent-kiran')).getByRole('button', { name: 'Listen to Kiran J’s call' });
    expect(refused.hasAttribute('disabled')).toBe(true);
    expect(document.getElementById(refused.getAttribute('aria-describedby')!)!.textContent).toBeTruthy();
    first.unmount();

    mocks.canListen = false;
    renderHome();
    await screen.findByTestId('home-agent-grid');
    expect(within(screen.getByTestId('home-agent-ravi')).queryByRole('button', { name: /Listen/ })).toBeNull();
  });

  it('make a stuck wrap-up available through the campaign floor’s confirmation', async () => {
    mocks.forceAgentAvailable.mockResolvedValue(undefined);
    renderHome();
    await screen.findByTestId('home-agent-grid');
    expect(within(screen.getByTestId('home-agent-ravi')).queryByRole('button', { name: /available/ })).toBeNull();
    fireEvent.click(within(screen.getByTestId('home-agent-divya')).getByRole('button', { name: 'Make Divya S available' }));
    fireEvent.click(await screen.findByTestId('force-available-button'));
    const reads = mocks.getAgencyFloor.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'End wrap-up and return' }));
    await waitFor(() => expect(mocks.forceAgentAvailable).toHaveBeenCalledWith('s-divya', '', 't-1', 'a-1'));
    // The floor is read again at once, not on the next tick.
    await waitFor(() => expect(mocks.getAgencyFloor.mock.calls.length).toBeGreaterThan(reads));
  });

  it('show Talk, Join and Send reminder as disabled controls that are coming soon', async () => {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    const ravi = screen.getByTestId('home-agent-ravi');
    for (const name of ['Talk to Ravi Kumar', 'Join Ravi Kumar’s call']) {
      const button = within(ravi).getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toMatch(/Coming soon\.$/);
    }
    // Reminders only for a break over the limit; nothing to talk to an absent agent about.
    expect(within(ravi).queryByRole('button', { name: /reminder/ })).toBeNull();
    expect(within(screen.getByTestId('home-agent-priya')).getByRole('button', { name: 'Send Priya M a reminder' }).hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByTestId('home-agent-naveen')).queryAllByRole('button')).toHaveLength(0);
  });

  it('fall back to each campaign’s figures, and say so, when the floor cannot be read', async () => {
    mocks.getAgencyFloor.mockRejectedValue(new Error('network'));
    renderHome();
    expect(await screen.findByTestId('home-agents-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('home-agent-grid')).toBeNull();
    expect(screen.getByTestId('home-floor')).toBeTruthy();
  });
});

describe('breaks over the limit', () => {
  it('are a row in Needs you now with a coming-soon Send reminder, left off the sidebar badge', async () => {
    renderHome();
    const row = await screen.findByTestId('home-attention-break-overrun:priya');
    expect(row.textContent).toContain('Priya M on Tea for 42 min');
    expect(row.textContent).toContain('Any break over 30 minutes is flagged. Limits per break reason are coming soon.');
    const remind = within(row).getByRole('button', { name: 'Send reminder' });
    expect(remind.hasAttribute('disabled')).toBe(true);
    expect(within(row).getByRole('link', { name: /Open the floor/ }).getAttribute('href')).toBe('/agency/campaigns/c1/agents');
    // On the page's own count, not the sidebar's.
    expect(screen.getByTestId('home-attention-count').textContent).toBe('1, 1');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });
});

describe('the tiles and cards from Phase 2’s reads', () => {
  it('count agents working from the floor, of everyone assigned', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId('kpi-agents').textContent).toBe('Agents working4of 10 assigned'));
  });

  it('make Successes Will pay while a campaign records promises, with the amount in lakh and no currency', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId('kpi-outcome').textContent).toBe('Will pay962.4 lakh promised today'));
    expect(await screen.findByText('71 will pay', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('home-campaign-c2').textContent).toContain('25 will pay');
  });

  it('keep Successes when no active campaign records promises', async () => {
    mocks.getAgencyPromisesSummary.mockResolvedValue(SUMMARY({ promise_campaign_ids: [] }));
    renderHome();
    await waitFor(() => expect(screen.getByTestId('kpi-outcome').textContent).toBe('Successes9Success rate 30% of conversations'));
    expect(screen.queryByText(/will pay/)).toBeNull();
  });

  it('say who paused a campaign, and when', async () => {
    renderHome();
    expect((await screen.findByTestId('home-campaign-status-c2')).textContent).toMatch(/^Paused by Anitha at \d{2}:\d{2} [ap]m$/);
    expect(screen.queryByTestId('home-campaign-status-c1')).toBeNull();
  });
});
