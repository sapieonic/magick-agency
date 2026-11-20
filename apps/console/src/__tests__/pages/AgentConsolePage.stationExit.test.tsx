import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The way OUT of the station, and the way it can refuse to let you IN
 * .
 *
 * Two defects are covered here and they are the same defect from either end:
 * there was no `Leave station` — `leaveAgencySession` had existed since Phase 1
 * and was called from nowhere, so the only exit was closing the tab — and the
 * new one-live-session-per-agent-per-tenant rule makes a join refusable for an
 * agent who did nothing wrong.
 *
 * Every assertion is on an observable consequence, per the discipline
 * `AgentConsolePage.test.tsx` sets out: a request sent, a location resolved, an
 * item refused with its reason on screen. Nothing here asserts a prop.
 */

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  leaveAgencySession: vi.fn(),
  useTenant: vi.fn(),
  trackAgencyStationJoinFailed: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyStationJoinFailed: mocks.trackAgencyStationJoinFailed,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));

import { stubStationMicrophone } from '../helpers/stationDevices';
import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { ApiError } from '../../api/client';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';
import { clearAllLiveSessions, rememberLiveSessionFromBootstrap, rememberLiveSessionFromConflict, readLiveSession } from '../../utils/agencyLiveSession';

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: { 'First Name': 'Asha' },
  prior_attempts: [],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
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
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

/** Renders wherever the console navigates to, so an exit is asserted as a location. */
function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.leaveAgencySession.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
      <Routes>
        <Route path="/station" element={<AgentConsolePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  // A 409 never reaches a socket — there is no session to connect one to.
  if (FakeSocket.instances.length > 0) {
    await act(async () => {
      latest().open();
    });
  }
  return view;
}

/** Whatever state the API last said the agent is in. The menu keys off nothing else. */
async function inState(state: string) {
  await act(async () => {
    if (state === 'on_call') {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-16T10:00:04.000Z' });
    }
    latest().emit({ event: 'agent_state', state, since: '2026-08-16T10:00:00.000Z' });
  });
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
}

/** ⋮ More → Finish work for today → screen 11 → Yes, finish work. */
function finishWork() {
  openMenu();
  fireEvent.click(screen.getByTestId('station-menu-finish'));
  expect(screen.getByTestId('band-title').textContent).toBe('Finish work for today?');
  fireEvent.click(screen.getByRole('button', { name: 'Yes, finish work' }));
}

describe('AgentConsolePage — Finish work for today (one control for Leave and Exit, spec §8)', () => {
  it('lives in the top bar’s ⋮ More, last and red, never in the footer beside the call’s controls', async () => {
    await mounted();
    await inState('available');
    openMenu();
    const items = Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"]'));
    const finish = items[items.length - 1]!;
    expect(finish.textContent).toBe('Finish work for today');
    expect(finish.getAttribute('data-stop')).toBe('true');
    expect(finish.closest('header')).not.toBeNull();
    expect(screen.getByTestId('station').querySelector('footer')!.contains(finish)).toBe(false);
  });

  it('asks first (11), then ends the session and lands the agent on their landing screen', async () => {
    await mounted();
    await inState('available');

    openMenu();
    fireEvent.click(screen.getByTestId('station-menu-finish'));
    // Behind a question: rejoining means a fresh session and a fresh place in the pool.
    expect(screen.getByTestId('band-subtitle').textContent).toBe('No more calls will come to you.');
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, finish work' }));

    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-1', 'tenant-1', 'account-1'),
    );
    // `?left=station` — without it their unchanged assignment would resolve and
    // send them straight back into the station they just left.
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dialer?left=station'),
    );
  });

  it('No, keep working (the big, safe choice) and Esc both go back without a request', async () => {
    await mounted();
    await inState('available');
    openMenu();
    fireEvent.click(screen.getByTestId('station-menu-finish'));
    fireEvent.click(screen.getByRole('button', { name: /No, keep working/ }));
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
    openMenu();
    fireEvent.click(screen.getByTestId('station-menu-finish'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
  });

  it('is on the break screens too, as a quiet link', async () => {
    await mounted();
    await inState('break');
    fireEvent.click(screen.getByTestId('break-finish-work'));
    expect(screen.getByTestId('band-title').textContent).toBe('Finish work for today?');
  });

  it('forgets the live station on finishing, so the next campaign is allowed to POST', async () => {
    await mounted();
    await inState('available');
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-1');

    finishWork();

    await waitFor(() => expect(readLiveSession('tenant-1')).toBeNull());
  });

  it.each(['reserved', 'on_call', 'wrapup'])(
    'is not offered in %s (hidden, not refused: AS1), so no request can be sent',
    async (state) => {
      mocks.useTenant.mockReturnValue({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'account_admin',
      });
      await mounted();
      await inState(state);

      openMenu();
      expect(screen.queryByTestId('station-menu-finish')).toBeNull();
      // During a call and on What happened? the menu holds only Sound and the screen colour.
      const items = Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"]')).map((n) => n.textContent);
      expect(items).toEqual(['Sound']);
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      expect(screen.queryByTestId('where')).toBeNull();
    },
  );

  it('has no separate Exit station, for any role', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
    await mounted();
    await inState('break');
    openMenu();
    expect(screen.queryByText(/exit station/i)).toBeNull();
    expect(screen.queryByText(/leave station/i)).toBeNull();
  });

  it('forgets this campaign when the session is gone, so a second join is allowed to POST', async () => {
    await mounted();
    await inState('available');
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-1');

    await act(async () => {
      latest().onclose?.({ code: 4404, reason: '' });
    });

    await waitFor(() => expect(readLiveSession('tenant-1')).toBeNull());
  });

  it('does not clear a newer campaign another tab already recorded when this session is gone', async () => {
    await mounted();
    await inState('available');
    rememberLiveSessionFromConflict('tenant-1', {
      error: 'Conflict',
      code: 'session_on_other_campaign',
      campaign_id: 'camp-other',
      campaign_name: 'Collections',
      state: 'available',
    });

    await act(async () => {
      latest().onclose?.({ code: 4404, reason: '' });
    });

    await waitFor(() =>
      expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-other'),
    );
  });

  it('sends a supervisor who finishes back to the campaign, not to the agent landing', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    await mounted();
    await inState('available');

    finishWork();

    await waitFor(() => expect(mocks.leaveAgencySession).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/agency/campaigns/camp-1'),
    );
  });

  it('moves through ⋮ More with the arrow keys, wrapping, and Esc returns focus to ⋮', async () => {
    await mounted();
    await inState('available');
    openMenu();
    const items = () => Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await waitFor(() => expect(document.activeElement).toBe(items()[0]));
    const all = items();
    for (let i = 1; i < all.length; i += 1) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(all[i]);
    }
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
  });

  /**
   * ── Reaching your own numbers without giving up your place in the queue ────
   *
   * What is asserted is the mechanism, not the presence of a link: `target` and
   * `rel` are the whole reason this is allowed to exist beside a live session.
   */
  describe('My calls today, from inside the station', () => {
    it('opens in a new tab with the opener severed', async () => {
      await mounted();
      await inState('available');
      openMenu();

      const calls = screen.getByTestId('station-menu-my_calls');
      expect(calls.getAttribute('href')).toBe('/dialer/attempts');
      /*
        `_blank` is not decoration. A same-tab link closes the station socket,
        and for up to 45 seconds the API still has the agent in the dialable pool
        with no console attached. A new tab leaves this document, its socket and
        its heartbeat exactly as they are.
      */
      expect(calls.getAttribute('target')).toBe('_blank');
      // And without `noopener` the opened tab holds a live `window.opener` on the document running a call.
      const rel = calls.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    });

    it('does not navigate the station away when activated, and the menu gets out of the way', async () => {
      await mounted();
      await inState('available');
      openMenu();

      const swallow = (event: Event) => event.preventDefault();
      document.addEventListener('click', swallow);
      try {
        fireEvent.click(screen.getByTestId('station-menu-my_calls'));
      } finally {
        document.removeEventListener('click', swallow);
      }

      expect(screen.queryByTestId('where')).toBeNull();
      expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      expect(screen.queryByTestId('station-menu-my_calls')).toBeNull();
    });
  });

  it('keeps the agent on the station when finishing fails, and says the work is still open', async () => {
    mocks.leaveAgencySession.mockRejectedValue(new Error('Request Failed'));
    await mounted();
    await inState('available');

    finishWork();

    // Navigating away on a leave that did not land would have the agent believe
    // they had stopped receiving calls while the API still had them in the pool.
    expect((await screen.findByTestId('finish-failure')).textContent).toBe('Your work is still open. Try again.');
    expect(screen.queryByTestId('where')).toBeNull();
  });

  /**
   * ── Escape during a leave request ──────────────────────────────────────────
   * Cancelling mid-flight used to unmount the question, and the rejection then set the failure
   * on a surface nobody could see — the agent believed they had left while the API still had
   * them in the pool.
   */
  it('ignores Escape while the leave is in flight, and still reports the failure', async () => {
    let reject: (err: Error) => void = () => {};
    mocks.leaveAgencySession.mockImplementation(
      () =>
        new Promise((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    await mounted();
    await inState('available');

    finishWork();

    // Mid-flight: the agent hits Escape, then No.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /No, keep working/ }));
    expect(screen.getByTestId('band-title').textContent).toBe('Finish work for today?');

    await act(async () => {
      reject(new Error('Request Failed'));
    });

    // The failure lands on a screen that is still there.
    expect((await screen.findByTestId('finish-failure')).textContent).toBe('Your work is still open. Try again.');
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

describe('AgentConsolePage — the join conflict', () => {
  const conflict = () =>
    new ApiError(409, {
      error: 'Conflict',
      code: 'session_on_other_campaign',
      campaign_id: 'camp-other',
      campaign_name: 'Collections',
      state: 'available',
    });

  it('names the campaign they are still joined to and links to it', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict());

    await mounted();

    const screenEl = await screen.findByTestId('join-conflict');
    expect(screenEl.textContent).toContain('Collections');
    expect(screenEl.textContent).toContain('Leave Collections first');
    // The link IS the remedy: that station is where the Leave control lives.
    expect(screen.getByRole('link', { name: /open collections/i }).getAttribute('href')).toBe(
      '/station?campaign=camp-other',
    );
  });

  it('gives the agent a way off the screen even here', async () => {
    // The other station can refuse them too — a stopped campaign, say — so even
    // the screen with a remedy on it keeps an escape.
    mocks.createAgencySession.mockRejectedValue(conflict());

    await mounted();
    await screen.findByTestId('join-conflict');

    expect(screen.getByTestId('station-escape').getAttribute('href')).toBe(
      '/dialer?left=refused',
    );
  });

  it('does not render it as a generic failure', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict());

    await mounted();
    await screen.findByTestId('join-conflict');

    // The one error the tenant-wide live-session rule makes reachable for an
    // ordinary agent — a bare "Conflict" would leave them with no remedy.
    expect(screen.queryByText('Your work did not open')).toBeNull();
  });

  it('still renders an ordinary join failure the ordinary way', async () => {
    mocks.createAgencySession.mockRejectedValue(new Error('Campaign is not running'));

    await mounted();

    await screen.findByText('Your work did not open');
    expect(screen.queryByTestId('join-conflict')).toBeNull();
  });

  /**
   * ── The dead end this screen used to be ────────────────────────────────────
   *
   * It returns before the header, so there is no `StationMenu`, no nav and no
   * sidebar — the console is full-viewport, outside the console shell. An assigned
   * agent whose campaign is paused is refused here, and `/app`, `/` and the
   * catch-all all resolve their assignment and return them to this same screen.
   * The only escape was a query param nobody can be expected to know.
   */
  it('gives an agent a way out, to a landing screen that will not bounce them back', async () => {
    mocks.createAgencySession.mockRejectedValue(new Error('Campaign is not running'));

    await mounted();
    await screen.findByText('Your work did not open');

    const escape = screen.getByTestId('station-escape');
    // `refused`, not `station`: they did not leave, and the landing screen must
    // not resolve their assignment and send them straight back here.
    expect(escape.getAttribute('href')).toBe('/dialer?left=refused');
  });

  it('sends a supervisor out to the campaign instead', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    mocks.createAgencySession.mockRejectedValue(new Error('Campaign is not running'));

    await mounted();
    await screen.findByText('Your work did not open');

    expect(screen.getByTestId('station-escape').getAttribute('href')).toBe(
      '/agency/campaigns/camp-1',
    );
  });

  it('falls back to the API’s sentence when the conflict body does not fully read', async () => {
    // The parser stays strict — no campaign id, no conflict screen, because one
    // that names no campaign reads as broken. But the API sends a `message` on this
    // 409, and its sentence is a better thing to show than "Could not join the
    // campaign." (Both the fallback and `ApiError`'s own message extraction land
    // on the same string today; what is asserted is what the agent reads.)
    mocks.createAgencySession.mockRejectedValue(
      new ApiError(409, {
        error: 'Conflict',
        code: 'session_on_other_campaign',
        message: 'You are already joined to another campaign in this workspace.',
      }),
    );

    await mounted();

    await screen.findByText('Your work did not open');
    expect(
      screen.getByText('You are already joined to another campaign in this workspace.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('join-conflict')).toBeNull();
  });
});

/**
 * The conflict screen's one-click remedy: leave `camp-other` and join `camp-1`
 * without ever navigating to `camp-other`'s own console. `leaveAgencySession`
 * needs a `session_id` the conflict body never carries, so the flow is three
 * chained requests behind one button — `createAgencySession('camp-other')` to
 * resume the existing session there and learn its id, `leaveAgencySession` on
 * it, then `createAgencySession('camp-1')` to join here for real.
 */
/**
 * 403 `not_staffed`: the API refuses a join on a campaign the agent is not staffed on (a
 * supervisor's role is exempt, server-side). The screen is `StationFatal` with the API's
 * own sentence, never the conflict screen (there is no station to leave) and never a bare
 * "Forbidden", and its escape is the landing screen that will not bounce them back.
 */
describe('AgentConsolePage — not staffed on the campaign', () => {
  const SENTENCE = "You're not assigned to this campaign. Ask your supervisor to add you.";
  const notStaffed = (body: Record<string, unknown> = { message: SENTENCE }) =>
    new ApiError(403, { error: 'Forbidden', code: 'not_staffed', ...body });

  // A live session another case remembered would refuse the join locally, before any POST.
  beforeEach(() => clearAllLiveSessions());

  it('says so in the API’s words, with the way home', async () => {
    mocks.createAgencySession.mockRejectedValue(notStaffed());

    await mounted();

    const fatal = await screen.findByRole('alert');
    expect(screen.getByTestId('band-title').textContent).toBe('Your work did not open');
    expect(fatal.textContent).toContain(SENTENCE);
    expect(screen.queryByTestId('join-conflict')).toBeNull();
    expect(screen.getByTestId('station-escape').getAttribute('href')).toBe('/dialer?left=refused');
    expect(mocks.trackAgencyStationJoinFailed).toHaveBeenCalledWith({ reason: 'not_staffed', conflict_state: null });
  });

  it('falls back to its own sentence when the refusal carries none', async () => {
    mocks.createAgencySession.mockRejectedValue(notStaffed({ message: '   ' }));

    await mounted();

    const fatal = await screen.findByRole('alert');
    expect(fatal.textContent).toContain('You’re not assigned to this campaign. Ask your supervisor to add you.');
  });

  it('does not remember a live session, so the next campaign still POSTs', async () => {
    mocks.createAgencySession.mockRejectedValue(notStaffed());

    await mounted();
    await screen.findByRole('alert');

    expect(readLiveSession('tenant-1')).toBeNull();
  });
});

/**
 * 409 `session_in_other_tenant` (OS1): the agent is live in another organisation. Nothing here can
 * end that session, so the screen is `StationFatal` with the API's sentence naming the workspace,
 * never the conflict screen, and nothing is remembered as a live session in THIS tenant.
 */
describe('AgentConsolePage — live in another organisation', () => {
  beforeEach(() => clearAllLiveSessions());

  it('says so in the API’s words, naming the workspace, with the way home', async () => {
    const sentence = 'You are live in Acme Collections. Leave your station there first: an agent can hold only one live station at a time.';
    mocks.createAgencySession.mockRejectedValue(new ApiError(409, {
      error: 'Conflict', code: 'session_in_other_tenant', message: sentence, tenant_id: 'tenant-2', tenant_name: 'Acme Collections',
    }));

    await mounted();

    const fatal = await screen.findByRole('alert');
    expect(fatal.textContent).toContain(sentence);
    expect(screen.queryByTestId('join-conflict')).toBeNull();
    expect(readLiveSession('tenant-1')).toBeNull();
  });

  it('falls back to its own sentence when the refusal carries none', async () => {
    mocks.createAgencySession.mockRejectedValue(new ApiError(409, {
      error: 'Conflict', code: 'session_in_other_tenant', message: '', tenant_id: 'tenant-2', tenant_name: null,
    }));

    await mounted();

    const fatal = await screen.findByRole('alert');
    expect(fatal.textContent).toContain('You are live in another organisation.');
  });
});

/**
 * OS4: a page the browser reloaded by itself (a discarded tab) joins WITHOUT taking the station;
 * refused because another device holds it, it says so and offers "Use this window instead", which
 * joins again taking it.
 */
describe('AgentConsolePage — a discarded tab does not take the station', () => {
  beforeEach(() => {
    clearAllLiveSessions();
    Object.defineProperty(document, 'wasDiscarded', { value: true, configurable: true });
  });
  afterEach(() => {
    delete (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
  });

  it('asks before taking it, and Use this window instead takes it', async () => {
    mocks.createAgencySession
      .mockRejectedValueOnce(new ApiError(409, {
        error: 'Conflict', code: 'station_on_other_device', message: 'open on your phone',
        session_id: 'sess-1', client_kind: 'mobile',
      }))
      .mockResolvedValue(BOOTSTRAP);

    await mounted();

    // Screen 12, the join's own: nothing moves until the agent says so.
    expect((await screen.findByTestId('band-title')).textContent).toBe('Your work is open on another device');
    expect(mocks.createAgencySession.mock.calls[0]![3]).toEqual({ takeOver: false });

    fireEvent.click(screen.getByRole('button', { name: /use this computer/i }));
    await waitFor(() => expect(mocks.createAgencySession).toHaveBeenCalledTimes(2));
    expect(mocks.createAgencySession.mock.calls[1]![3]).toEqual({ takeOver: true });
  });
});

describe('AgentConsolePage — the join conflict’s one-click switch', () => {
  const conflict = (state: string) =>
    new ApiError(409, {
      error: 'Conflict',
      code: 'session_on_other_campaign',
      campaign_id: 'camp-other',
      campaign_name: 'Collections',
      state,
    });

  const OTHER_BOOTSTRAP: AgencySessionBootstrap = {
    ...BOOTSTRAP,
    session_id: 'sess-other',
    campaign_id: 'camp-other',
    campaign_name: 'Collections',
  };

  it('is withheld while the agent is mid-call on the other campaign', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict('on_call'));

    await mounted();
    await screen.findByTestId('join-conflict');

    // Mid-call, the only way off that station is finishing the call there —
    // nothing on this screen may drop it on the agent's behalf.
    expect(screen.queryByTestId('switch-station')).toBeNull();
  });

  it('is offered while the agent is safely idle on the other campaign', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict('available'));

    await mounted();
    await screen.findByTestId('join-conflict');

    expect(screen.getByTestId('switch-station').textContent).toBe(
      'Leave Collections and work here',
    );
  });

  it('resumes the other session, leaves it, and joins here behind one confirm', async () => {
    let camp1Calls = 0;
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-1') {
        camp1Calls += 1;
        // The FIRST attempt is what produced this screen; the SECOND is the
        // rejoin `confirmSwitch` fires after leaving `camp-other`.
        return camp1Calls === 1 ? Promise.reject(conflict('available')) : Promise.resolve(BOOTSTRAP);
      }
      if (campaignId === 'camp-other') return Promise.resolve(OTHER_BOOTSTRAP);
      return Promise.reject(new Error(`unexpected campaign ${campaignId}`));
    });

    await mounted();
    await screen.findByTestId('join-conflict');

    fireEvent.click(screen.getByTestId('switch-station'));
    await screen.findByText(/close your work on Collections/);
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    // The id `leaveAgencySession` needed came from resuming `camp-other`, not
    // from the conflict body — which never carries one.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );
    await waitFor(() => expect(screen.queryByTestId('join-conflict')).toBeNull());
    expect(camp1Calls).toBe(2);
    // OS3: the look-up of the other campaign's session never takes its station; the rejoin
    // here (the agent's choice) does.
    const otherCalls = mocks.createAgencySession.mock.calls.filter((c) => c[0] === 'camp-other');
    expect(otherCalls.map((c) => c[3])).toEqual([{ takeOver: false }]);
  });

  it('OS3: the other campaign open on another device stops the switch there, taking nothing', async () => {
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-other') {
        return Promise.reject(new ApiError(409, {
          error: 'Conflict', code: 'station_on_other_device', message: 'open on your phone',
          session_id: 'sess-other', client_kind: 'mobile',
        }));
      }
      return Promise.reject(conflict('available'));
    });

    await mounted();
    await screen.findByTestId('join-conflict');
    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    await screen.findByText('Collections is open on another device. Leave it there, then join here.');
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
  });

  it('names which request failed, and leaves the dialog open to retry', async () => {
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-other') return Promise.resolve(OTHER_BOOTSTRAP);
      return Promise.reject(conflict('available'));
    });
    // The station itself refuses to close — the agent is still exactly where
    // they started, which is a different outcome from the rejoin failing.
    mocks.leaveAgencySession.mockRejectedValue(new Error('Network error'));

    await mounted();
    await screen.findByTestId('join-conflict');

    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    await screen.findByText('Collections is still open — Network error');
    // Not a dead end: the same button is the retry, not replaced by anything.
    expect(screen.getByRole('button', { name: 'Leave and work here' })).toBeTruthy();
    expect(screen.getByTestId('join-conflict')).toBeTruthy();
  });

  it('swaps in the new conflict when a third campaign wins the rejoin', async () => {
    // `camp-other` is left cleanly, but by the time the rejoin lands a THIRD
    // campaign's session has already claimed the agent's one tenant-wide slot
    // — the exact race `stage === 'rejoin'` exists to catch.
    let camp1Calls = 0;
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-1') {
        camp1Calls += 1;
        return camp1Calls === 1
          ? Promise.reject(conflict('available'))
          : Promise.reject(
              new ApiError(409, {
                error: 'Conflict',
                code: 'session_on_other_campaign',
                campaign_id: 'camp-third',
                campaign_name: 'Renewals',
                state: 'available',
              }),
            );
      }
      if (campaignId === 'camp-other') return Promise.resolve(OTHER_BOOTSTRAP);
      return Promise.reject(new Error(`unexpected campaign ${campaignId}`));
    });

    await mounted();
    await screen.findByTestId('join-conflict');

    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    // `camp-other` really was left — this is not a failure to leave.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );
    // The screen now describes the NEW conflict, not the old one, and the
    // confirm dialog for the stale campaign is gone rather than left open
    // over content that no longer matches it.
    await waitFor(() =>
      expect(screen.getByTestId('switch-station').textContent).toBe('Leave Renewals and work here'),
    );
    expect(screen.queryByText(/Collections/)).toBeNull();
    expect(
      screen.getByRole('link', { name: /open renewals/i }).getAttribute('href'),
    ).toBe('/station?campaign=camp-third');
    // The dialog itself — Cancel/confirm footer — is gone, not just relabelled.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-third');

    cleanup();
    mocks.createAgencySession.mockClear();
    await mounted();
    await screen.findByTestId('join-conflict');
    expect(mocks.createAgencySession).not.toHaveBeenCalled();
  });

  it('checks the OTHER campaign’s CURRENT state before leaving it, not the stale conflict snapshot', async () => {
    // The conflict says `available` — a snapshot from whenever the agent
    // first tried to join, taken from a page with no socket open to the other
    // campaign to keep it current. By the time they click through, resuming
    // that session reports `on_call`: a live customer, on a screen this one
    // has no visibility into. Leaving must not proceed on stale information.
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-1') return Promise.reject(conflict('available'));
      if (campaignId === 'camp-other') return Promise.resolve({ ...OTHER_BOOTSTRAP, state: 'on_call' });
      return Promise.reject(new Error(`unexpected campaign ${campaignId}`));
    });

    await mounted();
    await screen.findByTestId('join-conflict');

    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    // The resume happened — that alone is always safe, it only reads state —
    // but the live call it revealed must never be touched.
    await waitFor(() =>
      expect(mocks.createAgencySession).toHaveBeenCalledWith('camp-other', 'tenant-1', 'account-1', { takeOver: false }),
    );
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    // The screen catches up to the fresher truth: mid-call now, so the button
    // that would leave it is withdrawn rather than left there to press again.
    await waitFor(() => expect(screen.queryByTestId('switch-station')).toBeNull());
    expect(screen.getByTestId('join-conflict').textContent).toContain('on a call');
  });

  it('shows the ordinary join screen, not a stale conflict, when leave succeeds but rejoin does not', async () => {
    // The SECOND call to `camp-1` is the actual rejoin attempt, after
    // `camp-other` has already been left — and it fails with a PLAIN error,
    // not a fresh conflict (that race has its own test above).
    let camp1Calls = 0;
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-1') {
        camp1Calls += 1;
        return camp1Calls === 1
          ? Promise.reject(conflict('available'))
          : Promise.reject(new Error('Campaign is not running'));
      }
      if (campaignId === 'camp-other') return Promise.resolve(OTHER_BOOTSTRAP);
      return Promise.reject(new Error(`unexpected campaign ${campaignId}`));
    });

    await mounted();
    await screen.findByTestId('join-conflict');

    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    // The leave really happened — this is not a failure to leave.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );

    // The stale "still at another station" screen is gone — the agent really
    // isn't, any more — replaced by the ordinary join failure. Retrying THIS
    // dialog would have called `createAgencySession('camp-other')` again,
    // rejoining the campaign that was just left.
    await screen.findByText('Your work did not open');
    expect(
      screen.getByText('Left Collections, but couldn’t join this campaign — Campaign is not running'),
    ).toBeTruthy();
    expect(screen.queryByTestId('join-conflict')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave and work here' })).toBeNull();
  });

  /**
   * `main.tsx` wraps the whole app in `React.StrictMode`, which in
   * development mounts, unmounts and re-mounts every component on the SAME
   * fiber — refs survive the simulated unmount. `mountedRef`'s effect used to
   * be cleanup-only, which left it `false` for the rest of the page's life
   * after that first simulated unmount: `confirmSwitch` would still set
   * `switching` on the next real attempt, but the mount-guarded code that
   * clears it would never run, leaving the dialog stuck on "Switching…" with
   * Cancel disabled even once the three requests had already committed
   * (raised in review on PR #277).
   */
  it('does not get stuck on Switching… after a StrictMode double-invoked mount', async () => {
    // Keyed on whether `camp-other` has actually been left, NOT on a call
    // count: `StrictMode` fires the join effect's `createAgencySession('camp-1')`
    // twice on mount (once cancelled, once real) before any interaction, so a
    // "first call rejects, second resolves" mock would resolve the join right
    // there and never show the conflict screen this test depends on.
    let otherLeft = false;
    mocks.createAgencySession.mockImplementation((campaignId: string) => {
      if (campaignId === 'camp-1') return otherLeft ? Promise.resolve(BOOTSTRAP) : Promise.reject(conflict('available'));
      if (campaignId === 'camp-other') return Promise.resolve(OTHER_BOOTSTRAP);
      return Promise.reject(new Error(`unexpected campaign ${campaignId}`));
    });
    mocks.leaveAgencySession.mockImplementation((sessionId: string) => {
      if (sessionId === 'sess-other') otherLeft = true;
      return Promise.resolve(undefined);
    });

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
          <Routes>
            <Route path="/station" element={<AgentConsolePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await act(async () => {});
    // A 409 never reaches a socket, same as `mounted()` — nothing to open.

    await screen.findByTestId('join-conflict');
    fireEvent.click(screen.getByTestId('switch-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave and work here' }));

    // If `mountedRef` were stuck `false`, this never resolves — the dialog's
    // `setSwitching(false)` would be skipped and "Switching…" would hang.
    await waitFor(() => expect(screen.queryByTestId('join-conflict')).toBeNull());
  });

  it('refuses locally when this browser already holds another campaign, without posting', async () => {
    rememberLiveSessionFromBootstrap('tenant-1', {
      session_id: 'sess-other',
      campaign_id: 'camp-other',
      campaign_name: 'Collections',
      state: 'available',
    });

    await mounted();

    const screenEl = await screen.findByTestId('join-conflict');
    expect(screenEl.textContent).toContain('Collections');
    expect(mocks.createAgencySession).not.toHaveBeenCalled();
  });

  it('does not post a second join after a 409 once this browser knows the other campaign', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict('available'));

    await mounted();
    await screen.findByTestId('join-conflict');
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(1);

    cleanup();
    mocks.createAgencySession.mockClear();
    await mounted();
    await screen.findByTestId('join-conflict');
    expect(mocks.createAgencySession).not.toHaveBeenCalled();
  });

  it('still posts when joining the campaign this browser already holds — that is a resume', async () => {
    rememberLiveSessionFromBootstrap('tenant-1', BOOTSTRAP);

    await mounted();

    expect(mocks.createAgencySession).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1', { takeOver: true });
    expect(screen.queryByTestId('join-conflict')).toBeNull();
  });

  it('issues one POST under StrictMode when the join 409s', async () => {
    mocks.createAgencySession.mockRejectedValue(conflict('available'));

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
          <Routes>
            <Route path="/station" element={<AgentConsolePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await act(async () => {});
    await screen.findByTestId('join-conflict');
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(1);
  });
});
