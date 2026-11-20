import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { AgencyFloorAlert, AgencyFloorAlertsResponse } from '@magick-agency/contracts/api/agency/floor';
import { ApiError } from '../../api/client';

/**
 * The supervisor alerts on every page of the console's shell (agent station AS16), as
 * `SupervisorAlerts` reads them: only for a reader Live floor is for, every 5 s while the tab is
 * visible and one read at a time, quiet on a 403; a banner of plain words, each a link to Live
 * floor; the chime once per new alert (not for what was open at the first read), muted from the
 * banner for this browser; on Live floor no banner, and one chime for the page with Live floor's own.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string,
  flags: new Set<string>(['agency_dialer_enabled']),
  getAgencyFloorAlerts: vi.fn(),
  playHelpChime: vi.fn(),
  storage: new Map<string, string>(),
  storageBlocked: false,
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
vi.mock('../../utils/browserStorage', () => {
  const blocked = () => {
    if (mocks.storageBlocked) throw new DOMException('blocked', 'SecurityError');
  };
  return {
    browserStorage: () => ({
      getItem: (k: string) => { blocked(); return mocks.storage.get(k) ?? null; },
      setItem: (k: string, v: string) => { blocked(); mocks.storage.set(k, v); },
      removeItem: (k: string) => { blocked(); mocks.storage.delete(k); },
    }),
  };
});

import { SupervisorAlerts } from '../../components/layout/SupervisorAlerts';
import { FLOOR_ALERTS_POLL_MS } from '../../hooks/useFloorAlerts';
import { resetHeardAlertsForTests, useHelpChime } from '../../hooks/useHelpChime';
import { helpKeys } from '../../utils/agency/floorAssist';
import { resetHelpChimeChoiceForTests } from '../../utils/agency/floorAssist';

const AS_OF = '2026-11-20T10:30:00.000Z';
const base = { session_id: 's-1', agent_user_id: 'u-1', campaign_id: 'c-1', campaign_name: 'Collections' };

function help(name: string, id = `help:${name}`): AgencyFloorAlert {
  return { ...base, session_id: `s-${name}`, id, kind: 'help', agent_name: name, since: AS_OF, help: { raised_at: AS_OF, call_id: null } };
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
  mocks.storageBlocked = false;
  resetHelpChimeChoiceForTests();
  resetHeardAlertsForTests();
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

  it('on Live floor, still chimes for every kind it hears first', async () => {
    renderShell('/agency/home');
    await flush();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), breakOver('Asha')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(2);
    // Leaving Live floor: nothing heard there is new.
    fireEvent.click(screen.getByRole('button', { name: 'Go to /agency/campaigns' }));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('supervisor-alerts')).toBeTruthy();
  });
});

/**
 * Live floor's own chime, as `HomePage` mounts it: its floor read's open requests (`helpKeys`),
 * Need help only. One set of heard alerts for the page, so a request chimes exactly once.
 */
function FloorChime({ raised }: { raised: Array<{ name: string; at?: string }> | null }) {
  useHelpChime(
    raised === null ? null : helpKeys(raised.map(({ name, at = AS_OF }) => ({ session_id: `s-${name}`, help: { raised_at: at, call_id: null } }))),
    ['help'],
  );
  return null;
}

describe('one chime for the page: Live floor and the shell share what they heard', () => {
  it('a request first chimed on Live floor is never chimed again by the shell, there or after leaving', async () => {
    const view = renderShell('/agency/home');
    const floor = (raised: Array<{ name: string }>) => view.rerender(
      <MemoryRouter initialEntries={['/agency/home']}>
        <SupervisorAlerts />
        <FloorChime raised={raised} />
        <Routes>
          <Route path="/agency/campaigns" element={<Page to="/agency/home" />} />
          <Route path="/agency/home" element={<Page to="/agency/campaigns" />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    floor([]);
    await flush();
    // Live floor's read sees Ravi's request first: one chime.
    floor([{ name: 'Ravi' }]);
    await flush();
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    // The shell's read sees it next, on Live floor and after leaving it: nothing more.
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    await flush(FLOOR_ALERTS_POLL_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Go to /agency/campaigns' }));
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(screen.getByTestId('supervisor-alerts')).toBeTruthy();
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
  });

  it('a request the shell heard first is not chimed again when Live floor opens', async () => {
    const view = renderShell();
    await flush();
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi')));
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    view.rerender(
      <MemoryRouter initialEntries={['/agency/campaigns']}>
        <SupervisorAlerts />
        <FloorChime raised={[{ name: 'Ravi' }]} />
      </MemoryRouter>,
    );
    await flush(FLOOR_ALERTS_POLL_MS);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
  });

  it('a request raised just before Live floor opens chimes once, on the floor’s first read', async () => {
    const view = renderShell();
    await flush();
    // Live floor opens; its first read already has a request the shell has not read yet.
    view.rerender(
      <MemoryRouter initialEntries={['/agency/campaigns']}>
        <SupervisorAlerts />
        <FloorChime raised={[{ name: 'Asha' }]} />
      </MemoryRouter>,
    );
    await flush();
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Asha')));
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
  });

  it('what is open when the page loads on Live floor is shown, never chimed, by either read', async () => {
    mocks.getAgencyFloorAlerts.mockResolvedValue(answer(help('Ravi'), dropped('Meena')));
    render(
      <MemoryRouter initialEntries={['/agency/home']}>
        <FloorChime raised={[{ name: 'Ravi' }]} />
        <SupervisorAlerts />
      </MemoryRouter>,
    );
    await flush(FLOOR_ALERTS_POLL_MS * 2);
    expect(mocks.playHelpChime).not.toHaveBeenCalled();
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

  it('a chime mounted after a toggle agrees with it, even where storage is blocked', () => {
    mocks.storageBlocked = true;
    function One({ label }: { label: string }) {
      const chime = useHelpChime(null);
      return <button type="button" onClick={chime.toggle}>{`${label} ${chime.on ? 'on' : 'off'}`}</button>;
    }
    const first = render(<One label="shell" />);
    fireEvent.click(screen.getByRole('button', { name: 'shell on' }));
    expect(screen.getByRole('button', { name: 'shell off' })).toBeTruthy();
    // Live floor opened after muting from the banner: its chime starts off too.
    render(<One label="floor" />);
    expect(screen.getByRole('button', { name: 'floor off' })).toBeTruthy();
    first.unmount();
  });
});
