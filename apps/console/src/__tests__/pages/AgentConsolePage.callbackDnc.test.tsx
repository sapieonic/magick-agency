import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** The signed-in person's memberships: a member of the whole organisation unless a test says otherwise. */
const auth = vi.hoisted(() => ({ memberships: [] as Array<Record<string, unknown>> }));

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  markContactDnc: vi.fn(),
  useTenant: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
    memberships: auth.memberships,
  }),
}));

function membership(role: string, accountId: string | null = null) {
  return { id: 'm-1', user_id: 'u-1', tenant_id: 'tenant-1', account_id: accountId, role, status: 'active' };
}

const analyticsMocks = vi.hoisted(() => ({
  trackAgencyDncMarked: vi.fn(),
}));
vi.mock('../../analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics/events')>();
  return { ...actual, trackAgencyDncMarked: analyticsMocks.trackAgencyDncMarked };
});

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { STATION_COPY } from '../../utils/agency/stationCopy';
import { stubStationMicrophone } from '../helpers/stationDevices';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * The callback picker and mark-DNC, **at the page**.
 *
 * Two disciplines carried over from the agent console tests: nothing here asserts a
 * handler exists or a component got the right props — every keyboard test drives
 * a real `keydown` on `window` and asserts an observable consequence; and every
 * assertion goes through the page, because a green component test is not
 * evidence the page renders the component.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919820041772',
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
  disposition_catalog: [
    { code: 'sale', label: 'Sale' },
    // Deliberately NOT called `callback`: the built-in codes are conventions and
    // a campaign may rename them, so the shortcut must key on the flag.
    { code: 'ring_me_later', label: 'Ring me later', requires_datetime: true },
    { code: 'do_not_call', label: 'Do not call', suppress: true },
  ],
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

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  analyticsMocks.trackAgencyDncMarked.mockReset();
  // tenant_owner, so the RBAC mirror really grants `agency.dnc.write` rather
  // than the test asserting against a stub.
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  auth.memberships = [membership('tenant_owner')];
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.markContactDnc.mockResolvedValue({
    attempt_id: 'att-1',
    contact_id: 'c-1',
    phone_e164: '+919820041772',
    contact_state: 'suppressed',
    dnc_recorded: true,
  });
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
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

/** Bridged and talking. */
async function onCall() {
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt: ATTEMPT });
    latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
    latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
  });
  return view;
}

function press(key: string, target: Element | Document = document) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

/** The call ends owing an outcome: What happened? (05), where the tiles and Call when? are. */
async function whatHappened() {
  await act(async () => {
    latest().emit({ event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: true, message: 'x' });
    latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:02:00.000Z' });
  });
}

const saveNext = () => screen.getByRole('button', { name: /save & next call/i });

describe('the call-later copy promises only what is true (spec §6.6, AS8)', () => {
  /**
   * On a pool campaign a call-later goes back into the queue and whichever agent is free makes
   * it, so the agent who booked it may not be the one who calls. The copy says so; it never
   * promises "this call will come to you" there, and never says "I".
   */
  it('on a pool campaign says another agent may get the call', async () => {
    await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));
    const resolved = screen.getByTestId('callback-resolved');
    expect(resolved.textContent).toMatch(/^We will call on .+ at 10:00 AM\. Another agent may get the call\.$/);
  });

  it('on a campaign that assigns contacts says the call comes back to this agent', async () => {
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, assignment_mode: 'strict' });
    await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));
    expect(screen.getByTestId('callback-resolved').textContent).toMatch(/^This call will come to you on .+ at 10:00 AM\.$/);
  });

  it('asks the question plainly', async () => {
    await onCall();
    await whatHappened();
    press('c');
    expect(await screen.findByText(STATION_COPY.callWhen)).toBeTruthy();
  });

  it('contains no first-person-singular promise ANYWHERE the agent can read', async () => {
    // A regex over the whole rendered station, not over one string: the rule is about what an
    // agent might read aloud, and a future edit that reintroduces "I'll call you back" would
    // land in some other element.
    const view = await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));

    const text = view.container.textContent ?? '';
    expect(text).not.toMatch(/\bI['’]ll\b/i);
    expect(text).not.toMatch(/\bI will call\b/i);
    expect(text).not.toMatch(/\byou'?ll take this one\b/i);
    // And the positive form is present, so the test cannot pass on an empty page.
    expect(text).toContain('We will call');
  });
});

/**
 * The console's **assertive announcement region**, specifically.
 *
 * These two tests used a bare `findByRole('alert')`, which worked only while it
 * happened to be the page's sole alert. It is not: the hang-up failure is one,
 * and the microphone banner is another that renders on any environment without
 * `navigator.mediaDevices` — which is every test run under happy-dom. Selecting
 * on `aria-live="assertive"` names the region the assertion is actually about
 * rather than relying on there being only one.
 */
async function assertiveRegion(): Promise<HTMLElement> {
  const alerts = await screen.findAllByRole('alert');
  const assertive = alerts.find((el) => el.getAttribute('aria-live') === 'assertive');
  if (!assertive) throw new Error('no assertive live region on the console');
  return assertive;
}

describe('the confirmation after a callback is saved', () => {
  it('names the time the API booked, in the plural, on the page', async () => {
    // `confirmationCopy` is where the callback copy rule lives and it had **zero callers**: the
    // console announced a flat "Disposition saved." and the agent was never told
    // the time the system actually booked. This asserts the rendered live
    // region, so the copy cannot go dead again without reddening.
    mocks.submitDisposition.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      disposition_code: 'ring_me_later',
      contact_state: 'pending',
      next_attempt_at: '2026-08-12T10:00:00.000Z',
      agent_state: 'wrapup',
    });

    await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));

    await act(async () => {
      fireEvent.click(saveNext());
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toMatch(/We will call again on /));
    expect(live.textContent).toContain('Ring me later');
    expect(live.textContent).not.toMatch(/\bI['’]ll\b|\bI will\b/);
  });

  // The response's `callback_requested_at`
  // reaches the page, so a callback moved into calling hours says so.
  it('says when a callback was moved into calling hours', async () => {
    mocks.submitDisposition.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      disposition_code: 'ring_me_later',
      contact_state: 'pending',
      next_attempt_at: '2026-08-12T10:00:00.000Z',
      callback_requested_at: '2026-08-11T23:00:00.000Z',
      agent_state: 'wrapup',
    });

    await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));

    await act(async () => {
      fireEvent.click(saveNext());
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toContain('the first time we are allowed to call'));
  });

  it('still says “we” when the API scheduled something but named no time', async () => {
    mocks.submitDisposition.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      disposition_code: 'ring_me_later',
      contact_state: 'pending',
      next_attempt_at: 'not-a-date',
      agent_state: 'wrapup',
    });

    await onCall();
    await whatHappened();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10:00 AM' }));
    await act(async () => {
      fireEvent.click(saveNext());
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toContain('We'));
    // No invented time.
    expect(live.textContent).not.toContain('not-a-date');
  });
});

describe('the confirmation after a suppress outcome is saved (DS8)', () => {
  const saved = (dnc: Record<string, unknown>) => ({
    attempt_id: 'att-1',
    contact_id: 'c-1',
    disposition_code: 'do_not_call',
    contact_state: 'suppressed',
    next_attempt_at: null,
    agent_state: 'wrapup',
    ...dnc,
  });

  async function saveDoNotCall() {
    await onCall();
    await whatHappened();
    // The one outcome that asks (05c): picking the tile opens the question, Yes picks it.
    fireEvent.click(screen.getByTestId('outcome-do_not_call'));
    expect(screen.getByRole('dialog', { name: STATION_COPY.stopCallingTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: STATION_COPY.yesStopCalls }));
    expect(screen.getByTestId('outcome-do_not_call').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(saveNext());
    });
    return assertiveRegion();
  }

  it('says the number could not go on the list when the server wrote no entry', async () => {
    mocks.submitDisposition.mockResolvedValue(saved({ dnc_recorded: false }));
    const live = await saveDoNotCall();
    await waitFor(() => expect(live.textContent).toContain('Saved: Do not call.'));
    expect(live.textContent).toContain('Ask your supervisor to check the number.');
  });

  it('adds nothing when the entry is on the list', async () => {
    mocks.submitDisposition.mockResolvedValue(saved({ dnc_recorded: true }));
    const live = await saveDoNotCall();
    await waitFor(() => expect(live.textContent).toBe('Saved: Do not call.'));
  });
});

describe('the C shortcut', () => {
  it('selects the datetime-bearing code by its FLAG, not by the string “callback”', async () => {
    await onCall();
    await whatHappened();
    press('c');
    expect(screen.getByTestId('outcome-ring_me_later').getAttribute('aria-pressed')).toBe('true');
  });

  it('moves focus into the time row, not just the selection', async () => {
    // Selecting without focusing is a shortcut that half-works, and the agent
    // reaches for the mouse anyway.
    await onCall();
    await whatHappened();
    press('c');
    const firstChip = await screen.findByRole('button', { name: 'In 1 hour' });
    await waitFor(() => expect(document.activeElement).toBe(firstChip));
  });

  it('picks it on the call too, so What happened? opens with it chosen', async () => {
    await onCall();
    press('c');
    await whatHappened();
    expect(screen.getByTestId('outcome-ring_me_later').getAttribute('aria-pressed')).toBe('true');
  });

  it('does nothing while no call is on screen', async () => {
    await mounted();
    press('c');
    expect(screen.queryByText(STATION_COPY.callWhen)).toBeNull();
    expect(screen.queryByTestId('outcome-ring_me_later')).toBeNull();
  });
});

/**
 * Don't call again (spec 05c, §6.2). With an outcome that stops calls on the list, D (on the
 * call) and its tile (on What happened?) ask once and pick that outcome; saving records it. With
 * none, the red "Don't call again" row and D ask the same question and mark the number for this
 * work (today's Mark DNC, campaign scope only: the tenant-wide option stays with admins, off the
 * station).
 */
const NO_SUPPRESS: AgencySessionBootstrap = {
  ...BOOTSTRAP,
  disposition_catalog: BOOTSTRAP.disposition_catalog.filter((entry) => !entry.suppress),
};

async function onCallNoSuppress() {
  mocks.createAgencySession.mockResolvedValue(NO_SUPPRESS);
  return onCall();
}

const question = () => screen.queryByRole('dialog', { name: STATION_COPY.stopCallingTitle });
const yes = () => screen.getByRole('button', { name: new RegExp(`${STATION_COPY.yesStopCalls}|${STATION_COPY.stoppingCalls}`) });

describe('Don’t call again, with an outcome that stops calls', () => {
  it('D on the call asks, and Yes picks that outcome for What happened? — nothing is sent yet', async () => {
    await onCall();
    press('d');
    expect(question()).toBeTruthy();
    expect(question()!.textContent).toContain('+919820041772');
    fireEvent.click(yes());
    expect(question()).toBeNull();
    expect(mocks.markContactDnc).not.toHaveBeenCalled();
    await whatHappened();
    expect(screen.getByTestId('outcome-do_not_call').getAttribute('aria-pressed')).toBe('true');
    // No separate red row: the tile is the one way to say it.
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
  });

  it('No, go back leaves nothing picked', async () => {
    await onCall();
    await whatHappened();
    fireEvent.click(screen.getByTestId('outcome-do_not_call'));
    fireEvent.click(screen.getByRole('button', { name: STATION_COPY.noGoBack }));
    expect(question()).toBeNull();
    expect(screen.getByTestId('outcome-do_not_call').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Don’t call again, with no outcome that stops calls (today’s mark)', () => {
  it('is not offered when no call is on screen', async () => {
    mocks.createAgencySession.mockResolvedValue(NO_SUPPRESS);
    await mounted();
    press('d');
    expect(question()).toBeNull();
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
  });

  it('requires confirmation — D alone sends nothing', async () => {
    await onCallNoSuppress();
    press('d');
    expect(question()).toBeTruthy();
    expect(mocks.markContactDnc).not.toHaveBeenCalled();
  });

  it('says who and what, for this work only, and that it cannot be undone', async () => {
    await onCallNoSuppress();
    press('d');
    const text = question()!.textContent ?? '';
    expect(text).toContain('Asha · +919820041772');
    expect(text).toContain(STATION_COPY.stopCallingBody);
    // Never the wider, organisation-wide claim: that escalation is not on the station.
    expect(text).not.toContain('any campaign in this organisation');
  });

  it('sends the campaign-scoped mark on Yes, and never offers the tenant-wide one, even to an owner', async () => {
    await onCallNoSuppress();
    press('d');
    expect(screen.queryByRole('button', { name: /every campaign|whole organisation|all campaigns/i })).toBeNull();
    await act(async () => {
      fireEvent.click(yes());
    });
    expect(mocks.markContactDnc).toHaveBeenCalledWith('att-1', { scope: 'campaign' }, 'tenant-1', 'account-1');
    expect(mocks.markContactDnc).toHaveBeenCalledTimes(1);
    // The question closes once the mark lands, and the result is said.
    expect(question()).toBeNull();
    expect(await screen.findByTestId('dnc-outcome')).toBeTruthy();
  });

  /**
   * `opened_via` on `trackAgencyDncMarked` used to be hardcoded to `'click'` regardless of how
   * the question was opened — pinning both origins so a regression fails a test.
   */
  it('analytics: reports opened_via "click" when the red row opened it', async () => {
    await onCallNoSuppress();
    await whatHappened();
    fireEvent.click(screen.getByTestId('dont-call-again-row'));
    await act(async () => {
      fireEvent.click(yes());
    });
    expect(analyticsMocks.trackAgencyDncMarked).toHaveBeenCalledWith(expect.objectContaining({ opened_via: 'click' }));
  });

  it('analytics: reports opened_via "shortcut" when D opened it', async () => {
    await onCallNoSuppress();
    press('d');
    await act(async () => {
      fireEvent.click(yes());
    });
    expect(analyticsMocks.trackAgencyDncMarked).toHaveBeenCalledWith(expect.objectContaining({ opened_via: 'shortcut' }));
  });

  it('sends nothing when the agent backs out', async () => {
    await onCallNoSuppress();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: STATION_COPY.noGoBack }));
    });
    expect(mocks.markContactDnc).not.toHaveBeenCalled();
    expect(question()).toBeNull();
  });

  it('the outcome never claims the wider scope, even once the list write landed', async () => {
    mocks.markContactDnc.mockResolvedValue({ attempt_id: 'att-1', contact_id: 'c-1', phone_e164: '+919820041772', contact_state: 'suppressed', dnc_recorded: true });
    await onCallNoSuppress();
    press('d');
    await act(async () => {
      fireEvent.click(yes());
    });
    const outcome = await screen.findByTestId('dnc-outcome');
    // The station's own words (AS15), never wider than the mark.
    expect(outcome.textContent).toBe('Done. We will not call this number again.');
    expect(outcome.textContent).not.toMatch(/organisation|any campaign/);
  });

  it('reports a failure inline, in words, on the question it answers', async () => {
    mocks.markContactDnc.mockRejectedValue(Object.assign(new Error('Forbidden'), { details: { code: 'not_your_attempt' } }));
    await onCallNoSuppress();
    press('d');
    await act(async () => {
      fireEvent.click(yes());
    });
    expect(question()).toBeTruthy();
    expect(within(question()!).getByRole('alert').textContent).toContain('moved on');
  });

  it('clears the previous call’s result when the next call arrives', async () => {
    // An outcome about customer A, still on screen while the agent talks to customer B, is
    // worse than no message at all.
    await onCallNoSuppress();
    press('d');
    await act(async () => {
      fireEvent.click(yes());
    });
    await screen.findByTestId('dnc-outcome');

    await act(async () => {
      latest().emit({
        event: 'reserved',
        attempt: { ...ATTEMPT, attempt_id: 'att-2', contact_id: 'c-2', phone_e164: '+919000000000' },
      });
    });
    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
  });

  it('is not offered to a user the RBAC mirror denies', async () => {
    // `agency.dnc.write` floors at `agent`, so the only denying state is a user with no role at all.
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: undefined });
    await onCallNoSuppress();
    press('d');
    expect(question()).toBeNull();
    await whatHappened();
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
  });
});

/**
 * The mark's result belongs to the **customer on screen**, not to `live`: `released` clears
 * `live` while What happened? keeps that customer for the whole wrap-up window.
 *
 * ── Why the deferred promise ─────────────────────────────────────────────────
 * The interesting cases are all about *when* the response lands relative to `released` and
 * `reserved`; `deferredDnc()` puts that ordering in the test's hands.
 */
function deferredDnc(): {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  mocks.markContactDnc.mockReturnValue(
    new Promise((res, rej) => {
      resolve = res as (value: unknown) => void;
      reject = rej;
    }),
  );
  return { resolve, reject };
}

const DNC_RESPONSE = {
  attempt_id: 'att-1',
  contact_id: 'c-1',
  phone_e164: '+919820041772',
  contact_state: 'suppressed',
  dnc_recorded: true,
};

/** Ask with D and say Yes. */
async function markDnc() {
  press('d');
  await act(async () => {
    fireEvent.click(yes());
  });
}

/** The next customer arrives, which is the one event that clears the screen's customer. */
async function nextCallArrives() {
  await act(async () => {
    latest().emit({
      event: 'reserved',
      attempt: {
        ...ATTEMPT,
        attempt_id: 'att-2',
        contact_id: 'c-2',
        phone_e164: '+919000000000',
        context: { 'First Name': 'Ravi' },
      },
    });
  });
}

describe('the mark’s result survives the hangup it was made before', () => {
  it('keeps the confirmation through What happened?, beside the customer it is about', async () => {
    await onCallNoSuppress();
    await markDnc();
    await screen.findByTestId('dnc-outcome');

    await whatHappened();

    const outcome = screen.getByTestId('dnc-outcome');
    expect(outcome.textContent).toBe('Done. We will not call this number again.');
    expect(within(screen.getByTestId('customer-card')).getByText('Asha')).toBeTruthy();
  });

  it('clears it when the next customer arrives, so What happened? is a window and not forever', async () => {
    await onCallNoSuppress();
    await markDnc();
    await screen.findByTestId('dnc-outcome');
    await whatHappened();
    expect(screen.getByTestId('dnc-outcome')).toBeTruthy();

    await nextCallArrives();

    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
    expect(within(screen.getByTestId('customer-card')).getByText('Ravi')).toBeTruthy();
  });

  it('resolves a mark that was still in flight when the customer hung up', async () => {
    const dnc = deferredDnc();
    await onCallNoSuppress();
    await markDnc();
    // In flight, and the question says so.
    expect(yes().textContent).toBe(STATION_COPY.stoppingCalls);

    await whatHappened();
    await act(async () => {
      dnc.resolve(DNC_RESPONSE);
    });

    const outcome = await screen.findByTestId('dnc-outcome');
    expect(outcome.textContent).toBe('Done. We will not call this number again.');
    // …and nothing is left wedged: the question is answered and gone.
    expect(question()).toBeNull();
  });

  it('reports a failure that landed after the hangup, rather than swallowing it', async () => {
    const dnc = deferredDnc();
    await onCallNoSuppress();
    await markDnc();
    await whatHappened();

    await act(async () => {
      dnc.reject(Object.assign(new Error('Forbidden'), { details: { code: 'unknown_attempt' } }));
    });

    expect(within(question()!).getByRole('alert').textContent).toBe('That call has already ended. Nothing was changed.');
    expect(yes().textContent).toBe(STATION_COPY.yesStopCalls);
  });

  it('never paints the previous customer’s result onto the call that replaced them', async () => {
    const dnc = deferredDnc();
    const view = await onCallNoSuppress();
    await markDnc();
    fireEvent.click(screen.getByRole('button', { name: STATION_COPY.noGoBack }));

    await whatHappened();
    await nextCallArrives();

    // The response for att-1 lands while att-2 is on the line.
    await act(async () => {
      dnc.resolve(DNC_RESPONSE);
    });

    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
    expect(view.container.textContent ?? '').not.toContain('+919820041772');
    expect(view.container.textContent ?? '').toContain('+919000000000');
  });
});
