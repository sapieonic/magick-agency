import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  useTenant: vi.fn(),
  flag: vi.fn(),
  getMyContactsSummary: vi.fn(),
  listMyContacts: vi.fn(),
}));
vi.mock('../../api/agency', () => ({
  createAgencySession: mocks.createAgencySession,
  mintStationToken: mocks.mintStationToken,
  setAgentAvailable: mocks.setAgentAvailable,
  setAgentBreak: mocks.setAgentBreak,
  cancelQueuedBreak: mocks.cancelQueuedBreak,
  submitDisposition: mocks.submitDisposition,
  saveAttemptNotes: mocks.saveAttemptNotes,
  hangupAttempt: mocks.hangupAttempt,
}));
vi.mock('../../api/agencyAssignment', () => ({
  getMyContactsSummary: mocks.getMyContactsSummary,
  listMyContacts: mocks.listMyContacts,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: (flag: string) => (flag === 'agency_contact_assignment_enabled' ? mocks.flag() : false),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { stubStationMicrophone } from '../helpers/stationDevices';
import type { AgencySessionBootstrap } from '../../types/agency';

/**
 * The station on a `strict` / `preferred` campaign (contact assignment), driven
 * by real socket frames through the real hook, asserting what the agent sees:
 *
 *  - 02 No calls right now and why, from the bootstrap's `queue` and then from
 *    `queue` frames, instead of the promise of a call;
 *  - ⋮ More's My customers (today's My contacts), offered while no call is on screen and
 *    hidden while one is (AS1), closing if it was open.
 */

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Collections',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [{ code: 'sale', label: 'Sale' }],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [{ code: 'lunch', label: 'Lunch' }],
  context_display: {},
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
  assignment_mode: 'strict',
  allow_agent_retry: true,
  queue: { due: false, reason: 'queue_empty', next_due_at: null },
};

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.flag.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.getMyContactsSummary.mockReturnValue(new Promise(() => {}));
  mocks.listMyContacts.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latestSocket().open();
  });
  return view;
}

async function available() {
  await act(async () => {
    latestSocket().emit({ event: 'agent_state', state: 'available', since: '2026-11-03T10:00:00.000Z' });
  });
}

function openMyCustomers() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByTestId('station-menu-my_customers'));
}

describe('No calls right now (02c), from the agent’s own queue', () => {
  it('says so from the bootstrap’s queue before the socket states one', async () => {
    await mounted();
    await available();
    expect(screen.getByTestId('band-title').textContent).toBe('No calls right now');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('No customers are waiting. Stay on this screen.');
    expect(screen.getByTestId('no-calls').textContent).toContain('Calls will start again');
  });

  it('follows queue frames: a reason with the next time, then something due', async () => {
    await mounted();
    await available();
    await act(async () => {
      latestSocket().emit({
        event: 'queue', campaign_id: 'camp-1', due: false, reason: 'waiting_for_retry',
        next_due_at: '2026-11-03T12:30:00.000Z',
      });
    });
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Your next call is at 12:30 PM.');

    await act(async () => {
      latestSocket().emit({ event: 'queue', campaign_id: 'camp-1', due: true, reason: null, next_due_at: null });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
    expect(screen.queryByTestId('no-calls')).toBeNull();
  });

  it('a ready without a queue (a pool campaign) says nothing of the kind', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({ event: 'ready', session_id: 'sess-1', state: 'available' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
  });

  it('is absent on a pool campaign', async () => {
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'pool', queue: undefined });
    await mounted();
    await available();
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
  });
});

describe('My customers, under ⋮ More', () => {
  it('opens over the station while idle', async () => {
    await mounted();
    await available();
    openMyCustomers();
    expect(screen.getByTestId('my-contacts')).toBeTruthy();
    // The station underneath is still there, socket and all.
    expect(screen.getByTestId('station-band')).toBeTruthy();
  });

  it('suspends the station shortcuts while it is open, and they come back when it closes', async () => {
    await mounted();
    await available();
    openMyCustomers();
    expect(screen.getByTestId('my-contacts')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.queryByRole('dialog', { name: 'Which break?' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close My customers' }));
    expect(screen.queryByTestId('my-contacts')).toBeNull();
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.getByRole('dialog', { name: 'Which break?' })).toBeTruthy();
  });

  it('is hidden while a call is reserved (AS1) — and closes if open', async () => {
    await mounted();
    await available();
    openMyCustomers();
    expect(screen.getByTestId('my-contacts')).toBeTruthy();

    await act(async () => {
      latestSocket().emit({ event: 'agent_state', state: 'reserved', since: '2026-11-03T10:01:00.000Z' });
    });
    expect(screen.queryByTestId('my-contacts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-my_customers')).toBeNull();
    expect(screen.getByTestId('station-menu-sound')).toBeTruthy();
  });

  it('is not offered with the flag off, or on a pool campaign without agent retry', async () => {
    mocks.flag.mockReturnValue(false);
    await mounted();
    await available();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-my_customers')).toBeNull();
    cleanup();
    mocks.flag.mockReturnValue(true);
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'pool', allow_agent_retry: false });
    await mounted();
    await available();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-my_customers')).toBeNull();
  });
});

describe('My call-later list (02, phase 0 from my-contacts)', () => {
  it('lists today’s call-laters, earliest first, on an assigning campaign', async () => {
    const today = new Date();
    const at = (h: number) => { const d = new Date(today); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    const row = (id: string, name: string, h: number) => ({
      id, campaign_id: 'camp-1', phone_e164: '+919800000000', bucket: 'callback', state: 'pending', attempt_count: 1,
      last_outcome: null, last_disposition: null, next_attempt_at: at(h), last_attempt_at: null,
      hero: [{ name: 'Name', value: name }], retry: { eligible: false, blocked: null, rounds_used: 0, available_at: null }, override: null,
    });
    mocks.listMyContacts.mockResolvedValue({ rows: [row('b', 'Ravi', 23), row('a', 'Anjali Devi', 22)], next_cursor: null, limit: 50 });
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, queue: { due: true, reason: null, next_due_at: null } });
    await mounted();
    await available();
    const list = await screen.findByTestId('call-later-list');
    expect(list.textContent).toMatch(/Anjali Devi.*Ravi/);
    expect(list.textContent).toContain('These calls will come to you on time.');
    expect(mocks.listMyContacts).toHaveBeenCalledWith(
      expect.objectContaining({ campaign_id: 'camp-1', bucket: ['callback'] }),
      'tenant-1',
      'account-1',
    );
  });

  it('is not read on a pool campaign, where today’s server does not serve it', async () => {
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'pool', allow_agent_retry: true, queue: undefined });
    await mounted();
    await available();
    expect(mocks.listMyContacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('call-later-list')).toBeNull();
  });
});
