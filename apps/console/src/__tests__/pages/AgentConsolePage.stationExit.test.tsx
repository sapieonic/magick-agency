import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The way OUT of the station, and the way it can refuse to let you IN
 * (`MAG-160`, §A.1/§A.13.3).
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
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { ApiError } from '../../api/client';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';
import { rememberLiveSessionFromBootstrap, rememberLiveSessionFromConflict, readLiveSession } from '../../utils/agencyLiveSession';

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

beforeEach(() => {
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

/** Whatever state core last said the agent is in. The menu keys off nothing else. */
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
  fireEvent.click(screen.getByRole('button', { name: 'Station options' }));
}

describe('AgentConsolePage — the station menu', () => {
  it('lives in the header beside cue settings, never in the action bar', async () => {
    await mounted();

    // §A.13.9 fixes the action bar's sequence as a tab-order guarantee: an item
    // inserted there moves controls an agent reaches by muscle memory, and the
    // neighbour is the one that hangs up on a person.
    const trigger = screen.getByRole('button', { name: 'Station options' });
    const header = trigger.closest('header');
    expect(header).not.toBeNull();
    expect(header!.contains(screen.getByRole('button', { name: /sound & flash/i }))).toBe(true);
    // The action bar's own order is untouched.
    const bar = screen.getByRole('button', { name: /save disposition/i }).parentElement!;
    expect(bar.contains(trigger)).toBe(false);
    // The gear itself is in the trigger — a 28×28 well with global button
    // padding used to clip it to an empty square.
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('offers Leave while available, and it ends the session and lands the agent on their landing screen', async () => {
    await mounted();
    await inState('available');

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));

    // Behind a confirmation: rejoining means a fresh session and a fresh place
    // in the pool, and the item one row away does something quite different.
    await screen.findByText('You’ll stop receiving calls and your station will close.');
    fireEvent.click(screen.getByRole('button', { name: 'Leave station' }));

    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-1', 'tenant-1', 'account-1'),
    );
    // `?left=station` — without it their unchanged assignment would resolve and
    // send them straight back into the station they just left.
    // `/dialer`, not `/app`. The agent home moved there; routing the exit through
    // `/app` only worked because `AgentLanding` forwards the param, which is one
    // more hop and one more place for the arrival to be lost.
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dialer?left=station'),
    );
  });

  it('forgets the live station on Leave, so the next campaign is allowed to POST', async () => {
    await mounted();
    await inState('available');
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-1');

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave station' }));

    await waitFor(() => expect(readLiveSession('tenant-1')).toBeNull());
  });

  it.each(['reserved', 'on_call', 'wrapup'])(
    'refuses both exits in %s, with the reason on screen and no request sent',
    async (state) => {
      mocks.useTenant.mockReturnValue({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'account_admin',
      });
      await mounted();
      await inState(state);

      openMenu();
      const leave = screen.getByTestId('leave-station');
      const exit = screen.getByTestId('exit-station');
      expect(leave.getAttribute('aria-disabled')).toBe('true');
      expect(exit.getAttribute('aria-disabled')).toBe('true');

      // Refused, not `disabled`: this block BEGINS while the item may hold
      // focus, and a disabled element blurs under a keyboard agent's fingers.
      expect(leave.hasAttribute('disabled')).toBe(false);

      // A visible stated reason, and the two do not share it — they are
      // different acts and the refusals are about different things.
      const leaveReason = screen.getByText(/leaving now would cut the customer off/i);
      const exitReason = screen.getByText(/this call is still on your screen/i);
      expect(leaveReason.textContent).not.toBe(exitReason.textContent);

      fireEvent.click(leave);
      fireEvent.click(exit);
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      // Nothing navigated: the console is still on screen.
      expect(screen.queryByTestId('where')).toBeNull();
    },
  );

  it('hides Exit station from an agent — it would navigate them into a workspace they cannot see', async () => {
    await mounted();
    await inState('available');

    openMenu();
    expect(screen.getByTestId('leave-station')).toBeTruthy();
    expect(screen.queryByTestId('exit-station')).toBeNull();
  });

  /**
   * The asymmetry, at the surface an agent actually touches.
   *
   * Exit closes the socket and leaves the session live, and core's 45s
   * `available` lease is renewed by that socket's heartbeat alone while the
   * pacing engine reserves off Redis. So Exit in `available` leaves a dialable
   * agent with no console attached for up to 45 seconds — an answered call with
   * nobody on it. Leave is what ends the session, so it stays offered: it is the
   * correct action AND the remedy Exit's refusal names.
   */
  it('refuses Exit while available, keeps Leave, and names the remedy', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    await mounted();
    await inState('available');

    openMenu();
    const exit = screen.getByTestId('exit-station');
    expect(exit.getAttribute('aria-disabled')).toBe('true');
    // Still focusable: going `available` is exactly a transition that can land
    // while the item holds focus.
    expect(exit.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/still in the dialing pool/i)).toBeTruthy();
    // Not the mid-call sentence — there is no call.
    expect(screen.queryByText(/this call is still on your screen/i)).toBeNull();

    fireEvent.click(exit);
    expect(screen.queryByTestId('where')).toBeNull();

    // The way out is right above it, and it is not refused.
    const leave = screen.getByTestId('leave-station');
    expect(leave.getAttribute('aria-disabled')).toBeNull();
  });

  it('offers Exit station above agent, and it navigates WITHOUT ending the session', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    await mounted();
    // `break` — a supervisor who is out of the dialable pool. Exit is safe here
    // for the same reason it is not in `available`: nothing can be reserved onto
    // the console they are closing.
    await inState('break');

    openMenu();
    fireEvent.click(screen.getByTestId('exit-station'));

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/agency/campaigns/camp-1'),
    );
    // The whole difference between the two controls: a supervisor covering a
    // shift gets their screen back without telling the dialer they went home.
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    expect(readLiveSession('tenant-1')?.campaignId).toBe('camp-1');
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

  it('sends a supervisor who LEAVES back to the campaign, not to the agent landing', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    await mounted();
    await inState('available');

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave station' }));

    await waitFor(() => expect(mocks.leaveAgencySession).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/agency/campaigns/camp-1'),
    );
  });

  /**
   * Keyboard activation, not `fireEvent.click`.
   *
   * Every other case here clicks. A menu item is a real `<button>`, so Enter on
   * a focused one dispatches a click — which means the guard in `onClick` is the
   * guard the keyboard hits too, and that is worth proving rather than assuming:
   * a refusal implemented in a pointer handler would pass every click test in
   * this file and let a keyboard agent leave a station mid-call.
   */
  it('refuses a keyboard-activated Leave mid-call, having arrived by arrow keys', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    await mounted();
    await inState('on_call');

    // Open from the keyboard, exactly as a keyboard agent would.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Station options' }), { key: 'Enter' });
    const leave = await screen.findByTestId('leave-station');
    expect(document.activeElement).toBe(leave);

    fireEvent.keyDown(leave, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('exit-station'));
    fireEvent.keyDown(screen.getByTestId('exit-station'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(leave);

    // What Enter on a focused button actually produces.
    fireEvent.click(document.activeElement!);

    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    expect(screen.queryByText('You’ll stop receiving calls and your station will close.')).toBeNull();
  });

  /**
   * ── Reaching your own numbers without giving up your place in the queue ────
   *
   * `AgentHomePage` redirects an agent with one enterable assignment straight
   * into the station — its own comment calls that "the overwhelmingly common
   * shift" — and it used to be the only screen carrying links to
   * `/dialer/performance` and `/dialer/attempts`. So checking your own figures
   * required pressing Leave, which ends the session and drops you out of the
   * dialable pool.
   *
   * What is asserted is the mechanism, not the presence of a link: `target` and
   * `rel` are the whole reason this is allowed to exist beside a live call.
   */
  describe('the agent’s own numbers, from inside the station', () => {
    it('offers both destinations, in a new tab and with the opener severed', async () => {
      await mounted();
      await inState('available');
      openMenu();

      const performance = screen.getByTestId('station-history-0');
      const calls = screen.getByTestId('station-history-1');

      expect(performance.getAttribute('href')).toBe('/dialer/performance');
      expect(calls.getAttribute('href')).toBe('/dialer/attempts');

      for (const link of [performance, calls]) {
        /*
          `_blank` is not decoration. A same-tab link closes the station socket,
          and for up to 45 seconds core still has the agent in the dialable pool
          with no console attached — the "answered call with no agent" that Exit's
          `available` refusal exists to prevent. A new tab leaves this document,
          its socket and its heartbeat exactly as they are.
        */
        expect(link.getAttribute('target')).toBe('_blank');
        /*
          And without `noopener` the opened tab holds a live `window.opener` on
          the document running a call, and can navigate it.
        */
        const rel = link.getAttribute('rel') ?? '';
        expect(rel).toContain('noopener');
        expect(rel).toContain('noreferrer');
      }
    });

    it('says the station stays open, because that is the reader’s actual question', async () => {
      await mounted();
      await inState('available');
      openMenu();

      expect(screen.getByTestId('station-history-0').textContent).toContain('new tab');
      expect(screen.getByTestId('station-history-0').textContent).toContain('station stays open');
    });

    it.each(['reserved', 'on_call', 'wrapup', 'available'])(
      'is never refused while %s, because opening a tab does nothing to the call',
      async (state) => {
        /**
         * The two exit items are refused in these states and say why. These are
         * not exits: nothing about the call on screen changes, so there is
         * nothing to block — and a greyed item with no reason to give is the
         * house's own definition of a control that reads as a bug.
         */
        await mounted();
        await inState(state);
        openMenu();

        for (const testId of ['station-history-0', 'station-history-1']) {
          expect(screen.getByTestId(testId).getAttribute('aria-disabled')).toBeNull();
        }
      },
    );

    it('is reachable by the same arrow keys as the items above it', async () => {
      /**
       * The menu's roving focus filtered to `HTMLButtonElement`, so an anchor
       * item would have been Tab-reachable and arrow-unreachable — two items in
       * one popover behaving differently from the rest for a keyboard agent, on
       * the screen where that matters most.
       */
      mocks.useTenant.mockReturnValue({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'account_admin',
      });
      await mounted();
      await inState('available');

      fireEvent.keyDown(screen.getByRole('button', { name: 'Station options' }), { key: 'Enter' });
      const leave = await screen.findByTestId('leave-station');
      expect(document.activeElement).toBe(leave);

      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('exit-station'));
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('station-history-0'));
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('station-history-1'));
      // And wraps back round to the top, as it did before.
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(leave);
    });

    it('does not navigate the console away when one is activated', async () => {
      /**
       * The observable that matters: the station is still on screen afterwards.
       * A regression to a same-tab `<Link>` would resolve the route and unmount
       * the console with the socket still believed live.
       */
      await mounted();
      await inState('available');
      openMenu();

      /*
        The default action is suppressed only so happy-dom does not try to fetch
        `/dialer/performance` off a dev server that is not running. It is added
        AFTER the menu's own handlers, so everything under test still runs; what
        it removes is the environment's attempt to be a browser.
      */
      const swallow = (event: Event) => event.preventDefault();
      document.addEventListener('click', swallow);
      try {
        fireEvent.click(screen.getByTestId('station-history-0'));
      } finally {
        document.removeEventListener('click', swallow);
      }

      // Still the console. A same-tab `<Link>` would have resolved the route and
      // unmounted it with the socket still believed live.
      expect(screen.queryByTestId('where')).toBeNull();
      expect(screen.getByRole('button', { name: 'Station options' })).toBeTruthy();
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      // And the menu got out of the way, because the reader's attention has gone
      // to the new tab.
      expect(screen.queryByTestId('station-history-0')).toBeNull();
    });
  });

  it('keeps the agent on the station when the leave fails, and says the station is still open', async () => {
    mocks.leaveAgencySession.mockRejectedValue(new Error('Request Failed'));
    await mounted();
    await inState('available');

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave station' }));

    // Navigating away on a leave that did not land would have the agent believe
    // they had stopped receiving calls while core still had them in the pool.
    await screen.findByText(/your station is still open/i);
    expect(screen.queryByTestId('where')).toBeNull();
  });

  /**
   * ── Escape during a leave request ──────────────────────────────────────────
   *
   * `ConfirmDialog`'s `disabled` guards the confirm button only: Escape and a
   * click on the overlay call `onCancel` unconditionally. Cancelling mid-flight
   * therefore used to unmount the dialog, and the rejection then set the failure
   * on a surface nobody could see — the agent believed they had left while core
   * still had them in the pool, which is the exact outcome the navigation path
   * refuses to produce.
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

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave station' }));

    // Mid-flight: the agent hits Escape.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    await act(async () => {
      reject(new Error('Request Failed'));
    });

    // The failure lands on a dialog that is still on screen.
    await screen.findByText(/your station is still open/i);
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('refuses Exit while a leave is in flight', async () => {
    // Two exits racing: the supervisor would land on the campaign page believing
    // they were out of the pool, with a `POST /leave` that may still fail behind
    // them.
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    mocks.leaveAgencySession.mockImplementation(() => new Promise(() => {}));
    await mounted();
    await inState('break');

    openMenu();
    fireEvent.click(screen.getByTestId('leave-station'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave station' }));
    await act(async () => {});

    // Reopen the menu behind the dialog and try the other door.
    openMenu();
    const exit = screen.getByTestId('exit-station');
    expect(exit.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/wait for your leave request to finish/i)).toBeTruthy();
    fireEvent.click(exit);
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
    expect(screen.queryByText('Can’t open the station')).toBeNull();
  });

  it('still renders an ordinary join failure the ordinary way', async () => {
    mocks.createAgencySession.mockRejectedValue(new Error('Campaign is not running'));

    await mounted();

    await screen.findByText('Can’t open the station');
    expect(screen.queryByTestId('join-conflict')).toBeNull();
  });

  /**
   * ── The dead end this screen used to be ────────────────────────────────────
   *
   * It returns before the header, so there is no `StationMenu`, no nav and no
   * sidebar — the console is full-viewport, outside `AppLayout`. An assigned
   * agent whose campaign is paused is refused here, and `/app`, `/` and the
   * catch-all all resolve their assignment and return them to this same screen.
   * The only escape was a query param nobody can be expected to know.
   */
  it('gives an agent a way out, to a landing screen that will not bounce them back', async () => {
    mocks.createAgencySession.mockRejectedValue(new Error('Campaign is not running'));

    await mounted();
    await screen.findByText('Can’t open the station');

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
    await screen.findByText('Can’t open the station');

    expect(screen.getByTestId('station-escape').getAttribute('href')).toBe(
      '/agency/campaigns/camp-1',
    );
  });

  it('falls back to core’s sentence when the conflict body does not fully read', async () => {
    // The parser stays strict — no campaign id, no conflict screen, because one
    // that names no campaign reads as broken. But core sends a `message` on this
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

    await screen.findByText('Can’t open the station');
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
      'Leave Collections and join here',
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
    await screen.findByText(/closes your session on Collections/);
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

    // The id `leaveAgencySession` needed came from resuming `camp-other`, not
    // from the conflict body — which never carries one.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );
    await waitFor(() => expect(screen.queryByTestId('join-conflict')).toBeNull());
    expect(camp1Calls).toBe(2);
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
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

    await screen.findByText('Collections is still open — Network error');
    // Not a dead end: the same button is the retry, not replaced by anything.
    expect(screen.getByRole('button', { name: 'Leave & join here' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

    // `camp-other` really was left — this is not a failure to leave.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );
    // The screen now describes the NEW conflict, not the old one, and the
    // confirm dialog for the stale campaign is gone rather than left open
    // over content that no longer matches it.
    await waitFor(() =>
      expect(screen.getByTestId('switch-station').textContent).toBe('Leave Renewals and join here'),
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
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

    // The resume happened — that alone is always safe, it only reads state —
    // but the live call it revealed must never be touched.
    await waitFor(() =>
      expect(mocks.createAgencySession).toHaveBeenCalledWith('camp-other', 'tenant-1', 'account-1'),
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
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

    // The leave really happened — this is not a failure to leave.
    await waitFor(() =>
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-other', 'tenant-1', 'account-1'),
    );

    // The stale "still at another station" screen is gone — the agent really
    // isn't, any more — replaced by the ordinary join failure. Retrying THIS
    // dialog would have called `createAgencySession('camp-other')` again,
    // rejoining the campaign that was just left.
    await screen.findByText('Can’t open the station');
    expect(
      screen.getByText('Left Collections, but couldn’t join this campaign — Campaign is not running'),
    ).toBeTruthy();
    expect(screen.queryByTestId('join-conflict')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave & join here' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Leave & join here' }));

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

    expect(mocks.createAgencySession).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
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
