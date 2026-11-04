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
import type { AgencySessionBootstrap } from '../../types/agency';

/**
 * The station on a `strict` / `preferred` campaign (contact assignment), driven
 * by real socket frames through the real hook, asserting what the agent sees:
 *
 *  - "Nothing due now" and why, from the bootstrap's `queue` and then from
 *    `queue` frames, instead of the promise of a call;
 *  - the header's My contacts, present for the shift and refused in place while a
 *    call is reserved (and closed if it was open).
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

beforeEach(() => {
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

describe('Nothing due now', () => {
  it('says so from the bootstrap’s queue before the socket states one', async () => {
    await mounted();
    const nothing = screen.getByTestId('idle-nothing-due');
    expect(nothing.textContent).toContain('Nothing due now');
    expect(nothing.textContent).toContain('You have no open contacts right now.');
  });

  it('follows queue frames: a reason with the next time, then something due', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({
        event: 'queue', campaign_id: 'camp-1', due: false, reason: 'waiting_for_retry',
        next_due_at: '2026-11-03T12:30:00.000Z',
      });
    });
    expect(screen.getByTestId('idle-nothing-due').textContent)
      .toMatch(/Your contacts are scheduled for another try later\. The next one is due .+\./);

    await act(async () => {
      latestSocket().emit({ event: 'queue', campaign_id: 'camp-1', due: true, reason: null, next_due_at: null });
    });
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
    expect(screen.getByTestId('idle-guide')).toBeTruthy();
  });

  it('a ready without a queue (a pool campaign) says nothing of the kind', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({ event: 'ready', session_id: 'sess-1', state: 'available' });
    });
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
  });

  it('is absent on a pool campaign', async () => {
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'pool', queue: undefined });
    await mounted();
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
  });
});

describe('My contacts in the header', () => {
  it('opens over the station while idle', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({ event: 'agent_state', state: 'available', since: '2026-11-03T10:00:00.000Z' });
    });
    fireEvent.click(screen.getByTestId('my-contacts-open'));
    expect(screen.getByTestId('my-contacts')).toBeTruthy();
    // The console underneath is still there, socket and all.
    expect(screen.getByTestId('idle-guide')).toBeTruthy();
  });

  it('suspends the station shortcuts while it is open, and they come back when it closes', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({ event: 'agent_state', state: 'available', since: '2026-11-03T10:00:00.000Z' });
    });
    fireEvent.click(screen.getByTestId('my-contacts-open'));
    expect(screen.getByTestId('my-contacts')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.queryByRole('menu', { name: 'Break reasons' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close My contacts' }));
    expect(screen.queryByTestId('my-contacts')).toBeNull();
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.getByRole('menu', { name: 'Break reasons' })).toBeTruthy();
  });

  it('is refused in place, with the reason, while a call is reserved — and closes if open', async () => {
    await mounted();
    await act(async () => {
      latestSocket().emit({ event: 'agent_state', state: 'available', since: '2026-11-03T10:00:00.000Z' });
    });
    fireEvent.click(screen.getByTestId('my-contacts-open'));
    expect(screen.getByTestId('my-contacts')).toBeTruthy();

    await act(async () => {
      latestSocket().emit({ event: 'agent_state', state: 'reserved', since: '2026-11-03T10:01:00.000Z' });
    });
    expect(screen.queryByTestId('my-contacts')).toBeNull();
    const button = screen.getByTestId('my-contacts-open') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Finish this call first.');
  });

  it('is not offered with the flag off, or on a pool campaign without agent retry', async () => {
    mocks.flag.mockReturnValue(false);
    await mounted();
    expect(screen.queryByTestId('my-contacts-open')).toBeNull();
    cleanup();
    mocks.flag.mockReturnValue(true);
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'pool', allow_agent_retry: false });
    await mounted();
    expect(screen.queryByTestId('my-contacts-open')).toBeNull();
  });
});
