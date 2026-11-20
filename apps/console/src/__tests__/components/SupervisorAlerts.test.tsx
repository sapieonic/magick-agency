import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { AgencyFloorAlert, AgencyFloorAlertsResponse } from '@magick-agency/contracts/api/agency/floor';
import { ApiError } from '../../api/client';

/**
 * The supervisor alerts on every page of the console's shell (agent station AS16), as
 * `SupervisorAlerts` reads them: only for a reader Live floor is for, every 5 s while the tab is
 * visible and one read at a time, quiet on a 403; a banner of plain words, each a link to Live
 * floor; the chime once per new alert id (not for what was open at the first read), muted from the
 * banner for this browser; and on Live floor no banner and no second chime for Need help.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string,
  flags: new Set<string>(['agency_dialer_enabled']),
  getAgencyFloorAlerts: vi.fn(),
  playHelpChime: vi.fn(),
  storage: new Map<string, string>(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../api/agencyFloor', () => ({ getAgencyFloorAlerts: mocks.getAgencyFloorAlerts }));
vi.mock('../../utils/agency/helpChime', () => ({ playHelpChime: mocks.playHelpChime, unlockHelpChime: vi.fn() }));
vi.mock('../../utils/browserStorage', () => ({
  browserStorage: () => ({
    getItem: (k: string) => mocks.storage.get(k) ?? null,
    setItem: (k: string, v: string) => void mocks.storage.set(k, v),
    removeItem: (k: string) => void mocks.storage.delete(k),
  }),
}));

import { SupervisorAlerts } from '../../components/layout/SupervisorAlerts';
import { FLOOR_ALERTS_POLL_MS } from '../../hooks/useFloorAlerts';
import { useHelpChime } from '../../hooks/useHelpChime';

const AS_OF = '2026-11-20T10:30:00.000Z';
const base = { session_id: 's-1', agent_user_id: 'u-1', campaign_id: 'c-1', campaign_name: 'Collections' };

function help(name: string, id = `help:${name}`): AgencyFloorAlert {
  return { ...base, id, kind: 'help', agent_name: name, since: AS_OF, help: { raised_at: AS_OF, call_id: null } };
}
function breakOver(name: string, since = '2026-11-20T10:24:00.000Z'): AgencyFloorAlert {
  return {
    ...base, id: `break_over:${name}`, kind: 'break_over', agent_name: name, since,
    break_reason: 'tea', break_label: 'Tea', limit_minutes: 15, break_started_at: '2026-11-20T10:09:00.000Z',
  };
}
function dropped(name: string): AgencyFloorAlert {
  return { ...base, id: `disconnected:${name}`, kind: 'disconnected', agent_name: name, since: AS_OF, state: 'available', client_kind: 'web', call_id: null };
}
const answer = (...alerts: AgencyFloorAlert[]): AgencyFloorAlertsResponse => ({ alerts, as_of: AS_OF });

/** A page of the shell, with a way to Live floor and back. */
function Page({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>{`Go to ${to}`}</button>;
}

function renderShell(at = '/agency/campaigns') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <SupervisorAlerts />
      <Routes>
        <Route path="/agency/campaigns" element={<Page to="/agency/home" />} />
        <Route path="/agency/home" element={<Page to="/agency/campaigns" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const setVisible = (visible: boolean) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AS_OF));
  setVisible(true);
  mocks.role = 'account_admin';
  mocks.flags = new Set(['agency_dialer_enabled']);
  mocks.storage.clear();
  mocks.getAgencyFloorAlerts.mockResolvedValue(answer());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('who it asks for', () => {
  it('reads at once and every 5 s for a supervisor with the dialer on', async () => {
    renderShell();
    await flush();
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalledWith('t-1', 'a-1');
    await flush(FLOOR_ALERTS_POLL_MS * 3);
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalledTimes(4);
  });

  it('never asks for an agent, or with the dialer off', async () => {
    mocks.role = 'agent';
    renderShell();
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    cleanup();
    mocks.role = 'account_admin';
    mocks.flags = new Set();
    renderShell();
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(mocks.getAgencyFloorAlerts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('supervisor-alerts')).toBeNull();
  });

  it('pauses while the tab is hidden', async () => {
    renderShell();
    await flush();
    setVisible(false);
    await flush(FLOOR_ALERTS_POLL_MS * 4);
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while a read is on its way', async () => {
    mocks.getAgencyFloorAlerts.mockImplementation(() => new Promise(() => {}));
    renderShell();
    await flush(FLOOR_ALERTS_POLL_MS * 4);
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalledTimes(1);
  });

  it('stops asking on a 403 and shows nothing', async () => {
    mocks.getAgencyFloorAlerts.mockRejectedValue(new ApiError(403, { error: 'Forbidden', code: 'feature_disabled' }));
    renderShell();
    await flush(FLOOR_ALERTS_POLL_MS * 3);
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('supervisor-alerts')).toBeNull();
  });
});

describe('the banner', () => {
  it('lists the alerts in plain words, each a link to Live floor', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), breakOver('Asha'), dropped('Meena')));
    renderShell();
    await flush();
    const banner = screen.getByTestId('supervisor-alerts');
    const links = banner.querySelectorAll('a');
    expect([...links].map((a) => a.textContent)).toEqual([
      'Ravi needs help', 'Asha’s break is over by 6 min', 'Meena is disconnected',
    ]);
    for (const a of links) expect(a.getAttribute('href')).toBe('/agency/home');
  });

  it('lists three and counts the rest', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('A'), help('B'), help('C'), help('D'), help('E')));
    renderShell();
    await flush();
    expect(screen.getByTestId('supervisor-alerts-more').textContent).toBe('and 2 more on Live floor');
    expect(screen.getAllByTestId('supervisor-alert-help')).toHaveLength(3);
  });

  it('goes when the alerts clear, and after reads have failed for two periods', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    renderShell();
    await flush();
    expect(screen.getByTestId('supervisor-alerts')).toBeTruthy();
    mocks.getAgencyFloorAlerts.mockRejectedValue(new Error('network'));
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(screen.getByTestId('supervisor-alerts')).toBeTruthy();
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(screen.queryByTestId('supervisor-alerts')).toBeNull();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer());
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(screen.queryByTestId('supervisor-alerts')).toBeNull();
  });

  it('is not shown on Live floor, whose cards show the same', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    renderShell('/agency/home');
    await flush();
    expect(mocks.getAgencyFloorAlerts).toHaveBeenCalled();
    expect(screen.queryByTestId('supervisor-alerts')).toBeNull();
  });
});

describe('the chime', () => {
  it('plays once per new alert, never for what was open at the first read', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    renderShell();
    await flush();
    expect(mocks.playHelpChime).not.toHaveBeenCalled();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), dropped('Meena')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('supervisor-alerts-announcement').textContent).toBe('Meena is disconnected');
    // The same alerts again, and a minute's change of words: no second chime.
    mocks.getAgencyFloorAlerts.mockResolvedValue({ ...answer(help('Ravi'), dropped('Meena')), as_of: '2026-11-20T10:31:00.000Z' });
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
  });

  it('is muted from the banner for this browser, and stays quiet then', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    renderShell();
    await flush();
    const sound = screen.getByRole('button', { name: 'Alert sound' });
    expect(sound.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sound);
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    expect(mocks.storage.get('magick.liveFloor.helpChime.v1')).toBe('off');
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), help('Asha')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).not.toHaveBeenCalled();
  });

  it('on Live floor, leaves Need help to the page’s own chime but still plays for the other kinds', async () => {
    renderShell('/agency/home');
    await flush();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).not.toHaveBeenCalled();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), breakOver('Asha')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    // Leaving Live floor: the request heard there is not new.
    fireEvent.click(screen.getByRole('button', { name: 'Go to /agency/campaigns' }));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('supervisor-alerts')).toBeTruthy();
  });
});

describe('useHelpChime’s one setting', () => {
  it('a toggle in one chime moves every chime on the page', () => {
    function Two() {
      const a = useHelpChime(null);
      const b = useHelpChime(null);
      return (
        <>
          <button type="button" onClick={a.toggle}>{`a ${a.on ? 'on' : 'off'}`}</button>
          <span>{`b ${b.on ? 'on' : 'off'}`}</span>
        </>
      );
    }
    render(<Two />);
    fireEvent.click(screen.getByRole('button', { name: 'a on' }));
    expect(screen.getByText('b off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'a off' })).toBeTruthy();
  });
});
