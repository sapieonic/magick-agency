import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Listening's smaller surfaces (`docs/listening.md` LS2, LS13, §9): the agent's standing line in
 * the station header's info popover and on the campaign screen they join from, "Listened to by"
 * on a call's page, and the Calls tab's "Summary | Live" control.
 */

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(),
  useTenant: vi.fn(),
  getMyAssignments: vi.fn(),
}));

vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agency', () => ({ getMyAssignments: mocks.getMyAssignments }));

import {
  LISTEN_AGENT_NOTICE_SEEN_KEY,
  StationListenFirstNotice,
  StationListenNotice,
  agentListenScope,
} from '../../components/agency/StationListenNotice';
import { AgentHomePage } from '../../pages/agency/AgentHomePage';
import { ListenedToBy, listenDurationLabel, listenSpanLabel } from '../../components/listen/ListenedToBy';
import { CallsViews } from '../../components/agency/CallsViews';
import type { AgencyCallListenSession } from '../../types/live-calls';

const LINE = 'Calls may be listened to by a supervisor for quality and training.';

beforeEach(() => {
  mocks.flags = new Set();
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn() });
  mocks.getMyAssignments.mockResolvedValue([
    { campaign_id: 'c-1', campaign_name: 'Renewals', campaign_status: 'running', assigned_at: '2026-11-01T09:00:00Z' },
    { campaign_id: 'c-2', campaign_name: 'Collections', campaign_status: 'running', assigned_at: '2026-11-01T09:00:00Z' },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the station header’s info popover (LS2)', () => {
  it('is not there while listening is off', () => {
    render(<StationListenNotice />);
    expect(screen.queryByTestId('station-info')).toBeNull();
  });

  it('opens the standing line, and Escape closes it back onto the button', () => {
    mocks.flags.add('agency_live_listen_enabled');
    render(<StationListenNotice />);
    // Named for what it is about, so an agent looking for it finds it.
    const button = screen.getByRole('button', { name: 'Monitoring and recording' });
    expect(button.getAttribute('title')).toBe('Monitoring and recording');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('station-info-popover').textContent).toBe(LINE);
    expect(button.getAttribute('aria-controls')).toBe(screen.getByTestId('station-info-popover').id);
    fireEvent.keyDown(screen.getByTestId('station-info-popover'), { key: 'Escape' });
    expect(screen.queryByTestId('station-info-popover')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a click outside', () => {
    mocks.flags.add('agency_live_listen_enabled');
    render(
      <div>
        <StationListenNotice />
        <p data-testid="outside">elsewhere</p>
      </div>,
    );
    fireEvent.click(screen.getByTestId('station-info'));
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('station-info-popover')).toBeNull();
  });
});

describe('the one-time notice under the station’s or the soft phone’s header (LS2)', () => {
  const SCOPE = agentListenScope('u-1', 't-1', 'a-1')!;
  const DETAIL = 'You can read this again at any time under Monitoring and recording, the i button at the top of the screen.';

  it('scopes to the agent and the account, and needs all three', () => {
    expect(SCOPE).toBe('u-1:t-1:a-1');
    expect(agentListenScope(null, 't-1', 'a-1')).toBeNull();
    expect(agentListenScope('u-1', undefined, 'a-1')).toBeNull();
    expect(agentListenScope('u-1', 't-1', '')).toBeNull();
  });

  it('shows the standing line until the agent says Got it, then never again for them in this browser and account', () => {
    mocks.flags.add('agency_live_listen_enabled');
    const { unmount } = render(<StationListenFirstNotice scope={SCOPE} />);
    const notice = screen.getByTestId('listen-first-notice');
    expect(notice.textContent).toContain(LINE);
    expect(notice.textContent).toContain(DETAIL);
    expect(notice.getAttribute('aria-label')).toBe('About supervisors listening');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
    expect(window.localStorage.getItem(`${LISTEN_AGENT_NOTICE_SEEN_KEY}:${SCOPE}`)).toBe('1');
    unmount();
    render(<StationListenFirstNotice scope={SCOPE} />);
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
  });

  it('another agent on this browser, or this agent in another account, is told too', () => {
    mocks.flags.add('agency_live_listen_enabled');
    window.localStorage.setItem(`${LISTEN_AGENT_NOTICE_SEEN_KEY}:${SCOPE}`, '1');
    render(
      <>
        <StationListenFirstNotice scope="u-2:t-1:a-1" />
        <StationListenFirstNotice scope="u-1:t-1:a-2" />
      </>,
    );
    expect(screen.getAllByTestId('listen-first-notice')).toHaveLength(2);
  });

  it('nothing while listening is off, or with nobody to remember it for', () => {
    const { rerender } = render(<StationListenFirstNotice scope={SCOPE} />);
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
    mocks.flags.add('agency_live_listen_enabled');
    rerender(<StationListenFirstNotice scope={null} />);
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
  });

  it('with browser storage blocked it is still shown, and Got it still puts it away', () => {
    mocks.flags.add('agency_live_listen_enabled');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<StationListenFirstNotice scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
  });
});

describe('the campaign screen the agent joins from (LS2)', () => {
  function renderHome() {
    return render(
      <MemoryRouter initialEntries={['/dialer']}>
        <Routes>
          <Route path="/dialer" element={<AgentHomePage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('says calls may be listened to while listening is on', async () => {
    mocks.flags.add('agency_live_listen_enabled');
    renderHome();
    await waitFor(() => expect(screen.getByTestId('listen-agent-notice').textContent).toBe(LINE));
  });

  it('says nothing about it while listening is off', async () => {
    renderHome();
    await screen.findByText('Pick a campaign');
    expect(screen.queryByTestId('listen-agent-notice')).toBeNull();
  });
});

describe('Listened to by (LS13)', () => {
  const SESSIONS: AgencyCallListenSession[] = [
    { listen_id: 'l-2', listener_user_id: 'u-2', listener_name: 'Rohan Shah', started_at: '2026-11-16T14:04:00Z', ended_at: '2026-11-16T14:05:02Z', end_reason: 'call_ended', duration_seconds: 62 },
    { listen_id: 'l-1', listener_user_id: 'u-1', listener_name: 'Anita Kapoor', started_at: '2026-11-16T14:02:00Z', ended_at: '2026-11-16T14:05:10Z', end_reason: 'listener_stopped', duration_seconds: 190 },
    { listen_id: 'l-3', listener_user_id: 'u-3', listener_name: null, started_at: '2026-11-16T14:06:00Z', ended_at: null, end_reason: null, duration_seconds: null },
  ];

  it('lists who listened, earliest first, with when and for how long', () => {
    render(<ListenedToBy sessions={SESSIONS} />);
    expect(screen.getByRole('heading', { name: 'Listened to by' })).toBeTruthy();
    const items = within(screen.getByTestId('listened-to-by')).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(['listened-l-1', 'listened-l-2', 'listened-l-3']);
    expect(items[0]!.textContent).toBe(`AKAnita Kapoor${listenSpanLabel(SESSIONS[1]!)}3m 10s`);
    expect(items[1]!.textContent).toContain('1m 2s');
    expect(items[2]!.textContent).toContain('A supervisor');
    expect(items[2]!.textContent).toContain('Listening now');
  });

  it('renders nothing for a call nobody listened to, or a server without the field', () => {
    const { container, rerender } = render(<ListenedToBy sessions={[]} />);
    expect(container.textContent).toBe('');
    rerender(<ListenedToBy sessions={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('words the span and the duration', () => {
    expect(listenSpanLabel({ started_at: '2026-11-16T14:02:00Z', ended_at: '2026-11-16T14:05:10Z' })).toMatch(/^\d{2}:\d{2}.*–\d{2}:\d{2}.*$/);
    expect(listenSpanLabel({ started_at: '2026-11-16T14:02:00Z', ended_at: null })).toMatch(/^since /);
    expect(listenSpanLabel({ started_at: 'nonsense', ended_at: null })).toBe('—');
    expect(listenSpanLabel({ started_at: '2026-11-16T23:58:00Z', ended_at: '2026-11-17T00:02:00Z' })).toContain('17 Nov');
    expect(listenDurationLabel({ duration_seconds: 190, ended_at: 'x' })).toBe('3m 10s');
    expect(listenDurationLabel({ duration_seconds: null, ended_at: null })).toBe('Listening now');
  });
});

describe('Summary | Live on the Calls tab', () => {
  function renderViews(active: 'calls' | 'live', entry = '/agency/campaigns/c-1/calls?range=7d', liveCount: number | null = null) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <CallsViews campaignId="c-1" active={active} role="account_admin" liveCount={liveCount} />
      </MemoryRouter>,
    );
  }

  it('offers both views to a supervisor with listening on, Summary keeping the range', () => {
    mocks.flags.add('agency_live_listen_enabled');
    renderViews('calls');
    expect(screen.getByTestId('calls-view-calls').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('calls-view-calls').getAttribute('href')).toBe('/agency/campaigns/c-1/calls?range=7d');
    expect(screen.getByTestId('calls-view-live').getAttribute('href')).toBe('/agency/campaigns/c-1/calls/live');
    expect(screen.getByTestId('calls-view-live').getAttribute('aria-current')).toBeNull();
  });

  it('marks Live on the Live view, with its count', () => {
    mocks.flags.add('agency_live_listen_enabled');
    renderViews('live', '/agency/campaigns/c-1/calls/live', 3);
    expect(screen.getByTestId('calls-view-live').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('calls-view-live').textContent).toBe('Live 3');
    expect(screen.getByTestId('calls-view-calls').getAttribute('href')).toBe('/agency/campaigns/c-1/calls');
  });

  it('is not offered while listening is off', () => {
    renderViews('calls');
    expect(screen.queryByTestId('calls-views')).toBeNull();
  });
});
