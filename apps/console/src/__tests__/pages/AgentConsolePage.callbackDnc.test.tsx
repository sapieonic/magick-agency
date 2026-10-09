import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
  }),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackAgencyDncMarked: vi.fn(),
}));
vi.mock('../../analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics/events')>();
  return { ...actual, trackAgencyDncMarked: analyticsMocks.trackAgencyDncMarked };
});

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import {
  CALLBACK_GROUND_TRUTH_COPY,
  CALLBACK_TIMEZONE_COPY,
} from '../../components/agency/DispositionPad';
import {
  DNC_CAMPAIGN_ACTION_LABEL,
  DNC_CONFIRM_TITLE,
  DNC_TENANT_ACTION_LABEL,
} from '../../utils/agencyDncCopy';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * `AD-P3-U-03` — the callback picker and mark-DNC, **at the page**.
 *
 * Two disciplines carried over from `AD-P2-U-01`/`U-04`: nothing here asserts a
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

beforeEach(() => {
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  analyticsMocks.trackAgencyDncMarked.mockReset();
  // tenant_owner, so the RBAC mirror really grants `agency.dnc.write` rather
  // than the test asserting against a stub.
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
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

describe('CR-1 — the callback copy says “we”, never “I”', () => {
  /**
   * This is the **entire** mitigation for D11: a callback returns the contact to
   * `pending` and the pacing engine hands it to whichever agent is free, so the
   * agent who booked it is not the agent who makes it. Nothing in the product
   * enforces the promise — only this copy bounds it, and until now nothing
   * pinned the copy.
   */
  it('renders the ground truth beside the time picker, on the page', async () => {
    await onCall();
    press('c');

    const groundTruth = await screen.findByTestId('callback-ground-truth');
    expect(groundTruth.textContent).toBe(CALLBACK_GROUND_TRUTH_COPY);
    expect(groundTruth.textContent).toContain('It may not be you who makes it');
  });

  it('asks the question in the plural too', async () => {
    await onCall();
    press('c');
    expect(await screen.findByText('When should we call back?')).toBeTruthy();
  });

  it('contains no first-person-singular promise ANYWHERE the agent can read', async () => {
    // A regex over the whole rendered console, not over one string: the rule is
    // about what an agent might read aloud, and a future edit that reintroduces
    // "I'll call you back" would land in some other element.
    const view = await onCall();
    press('c');
    await screen.findByTestId('callback-ground-truth');

    const text = view.container.textContent ?? '';
    expect(text).not.toMatch(/\bI['’]ll\b/i);
    expect(text).not.toMatch(/\bI will call\b/i);
    expect(text).not.toMatch(/\byou'?ll take this one\b/i);
    // And the positive form is present, so the test cannot pass on an empty page.
    expect(text).toContain('call back');
  });

  it('names whose clock the picker is on, because it is not the customer’s', async () => {
    await onCall();
    press('c');
    const note = await screen.findByTestId('callback-timezone-note');
    expect(note.textContent).toBe(CALLBACK_TIMEZONE_COPY);
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
  it('names the time core booked, in the plural, on the page', async () => {
    // `confirmationCopy` is where CR-1 lives and it had **zero callers**: the
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
    press('c');
    await screen.findByTestId('callback-ground-truth');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10am' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save disposition/i }));
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toMatch(/We['’]ll call back/));
    expect(live.textContent).toContain('Ring me later');
    expect(live.textContent).not.toMatch(/\bI['’]ll\b/);
  });

  // NEW (magick-agency, CONTRACT-DIFF §1): the response's `callback_requested_at`
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
    press('c');
    await screen.findByTestId('callback-ground-truth');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10am' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save disposition/i }));
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toContain('the next time inside calling hours'));
  });

  it('still says “we” when core scheduled something but named no time', async () => {
    mocks.submitDisposition.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      disposition_code: 'ring_me_later',
      contact_state: 'pending',
      next_attempt_at: 'not-a-date',
      agent_state: 'wrapup',
    });

    await onCall();
    press('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow 10am' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save disposition/i }));
    });

    const live = await assertiveRegion();
    await waitFor(() => expect(live.textContent).toContain('We'));
    // No invented time.
    expect(live.textContent).not.toContain('not-a-date');
  });
});

describe('the C shortcut', () => {
  it('selects the datetime-bearing code by its FLAG, not by the string “callback”', async () => {
    await onCall();
    press('c');

    const option = await screen.findByRole('button', { name: /Ring me later/ });
    expect(option.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves focus into the time row, not just the selection', async () => {
    // Selecting without focusing is a shortcut that half-works, and the agent
    // reaches for the mouse anyway.
    await onCall();
    press('c');
    const firstChip = await screen.findByRole('button', { name: 'In 1 hour' });
    await waitFor(() => expect(document.activeElement).toBe(firstChip));
  });

  it('does nothing while the pad is disabled', async () => {
    await mounted();
    press('c');
    expect(screen.queryByText('When should we call back?')).toBeNull();
  });
});

describe('mark DNC', () => {
  it('is composed into the console and disabled off-call, with the reason stated', async () => {
    await mounted();
    expect((screen.getByTestId('dnc-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain('on a call');
  });

  it('requires confirmation — D alone sends nothing', async () => {
    await onCall();
    press('d');

    // The dialog is up, and no request has been made.
    expect(screen.getByText(DNC_CONFIRM_TITLE)).toBeTruthy();
    expect(mocks.markContactDnc).not.toHaveBeenCalled();
  });

  it('states the DEFAULT option’s scope with the number and campaign in it, and never overstates it', async () => {
    // The single action became a choice (§A.7.5 revision): the default is
    // scoped to the campaign the agent is on, and its own copy must not borrow
    // the wider, workspace-wide claim that belongs to the escalation below.
    await onCall();
    press('d');
    const message = screen.getByText(/won.t be called again by Renewals/);
    expect(message.textContent).toContain('+919820041772');
    expect(message.textContent).toContain('Renewals');
    expect(message.textContent).toContain('undo');
    expect(message.textContent).not.toContain('any campaign in this workspace');
  });

  it('states the ESCALATION’s scope and permanence with the number in it, unmistakably', async () => {
    // beforeEach's `tenant_owner` holds `agency.dnc.manage`, so the escalation
    // is on offer. Its hint carries the compliance-bearing claim the default
    // must not make: every campaign, forever, admin-only to reverse.
    await onCall();
    press('d');
    const hint = screen.getByTestId('confirm-secondary-hint');
    expect(hint.textContent).toContain('+919820041772');
    expect(hint.textContent).toContain('any campaign in this workspace');
    expect(hint.textContent).toContain('permanently');
    expect(hint.textContent).toContain('undo');
  });

  it('sends the campaign-scoped mark when the agent picks the default', async () => {
    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });
    expect(mocks.markContactDnc).toHaveBeenCalledWith(
      'att-1',
      { scope: 'campaign' },
      'tenant-1',
      'account-1',
    );
  });

  /**
   * `opened_via` on `trackAgencyDncMarked` used to be hardcoded to `'click'`
   * regardless of how the dialog was opened — pinning both origins here so a
   * regression to the hardcoded version fails a test instead of just under-
   * reporting shortcut usage silently.
   */
  it('analytics: reports opened_via "click" when the button opened the dialog', async () => {
    await onCall();
    await act(async () => {
      fireEvent.click(screen.getByTestId('dnc-button'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });
    expect(analyticsMocks.trackAgencyDncMarked).toHaveBeenCalledWith(
      expect.objectContaining({ opened_via: 'click' }),
    );
  });

  it('analytics: reports opened_via "shortcut" when the D key opened the dialog', async () => {
    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });
    expect(analyticsMocks.trackAgencyDncMarked).toHaveBeenCalledWith(
      expect.objectContaining({ opened_via: 'shortcut' }),
    );
  });

  it('sends the tenant-wide mark when the agent picks the escalation, and only then', async () => {
    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_TENANT_ACTION_LABEL }));
    });
    expect(mocks.markContactDnc).toHaveBeenCalledWith(
      'att-1',
      { scope: 'tenant' },
      'tenant-1',
      'account-1',
    );
    expect(mocks.markContactDnc).toHaveBeenCalledTimes(1);
  });

  it('hides the tenant-wide escalation for a role lacking agency.dnc.manage — the campaign default still works', async () => {
    // `agent` (level 5) holds `agency.dnc.write` (floor: `agent`) but not
    // `agency.dnc.manage` (floor: `account_admin`, level 30) — the same floor
    // master already uses for REMOVING an entry. Hiding the wider escalation
    // must not disable the narrower, default action.
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
    await onCall();
    press('d');

    expect(screen.queryByRole('button', { name: DNC_TENANT_ACTION_LABEL })).toBeNull();
    expect(screen.queryByTestId('confirm-secondary-hint')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });
    expect(mocks.markContactDnc).toHaveBeenCalledWith(
      'att-1',
      { scope: 'campaign' },
      'tenant-1',
      'account-1',
    );
  });

  it('sends nothing when the agent backs out', async () => {
    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    });
    expect(mocks.markContactDnc).not.toHaveBeenCalled();
    expect(screen.queryByText(DNC_CONFIRM_TITLE)).toBeNull();
  });

  it('weakens the ESCALATION’s outcome to this campaign when the list write is in flight', async () => {
    mocks.markContactDnc.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      phone_e164: '+919820041772',
      contact_state: 'suppressed',
      dnc_recorded: false,
    });

    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_TENANT_ACTION_LABEL }));
    });

    const outcome = await screen.findByTestId('dnc-outcome');
    expect(outcome.textContent).toContain('this campaign');
    expect(outcome.textContent).not.toContain('No campaign in this workspace');
  });

  it('the DEFAULT’s outcome never claims the wider scope, even once the list write landed', async () => {
    // `dnc_recorded: true` is the strongest response the default can get, so it
    // is the case in which an overstatement would be easiest to excuse. The
    // campaign-scoped mark still may not borrow the escalation's wording.
    //
    // (This arm DOES read `dnc_recorded` — see `agencyDncCopy.ts`. It once did
    // not, on the reasoning that core suppresses the roster row directly; that is
    // true of the ROSTER and false of the LIST the sentence names. The
    // `dnc_recorded: false` wording is pinned in `agencyDncCopy.test.ts`.)
    mocks.markContactDnc.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      phone_e164: '+919820041772',
      contact_state: 'suppressed',
      dnc_recorded: true,
    });

    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });

    const outcome = await screen.findByTestId('dnc-outcome');
    expect(outcome.textContent).toContain('this campaign');
    expect(outcome.textContent).not.toContain('No campaign in this workspace');
  });

  it('reports a failure inline, in words, rather than as a support message', async () => {
    mocks.markContactDnc.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { details: { code: 'not_your_attempt' } }),
    );

    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
    });

    const failure = await screen.findByTestId('dnc-failure');
    expect(failure.textContent).toContain('moved on');
  });

  it('clears the previous call’s result when the next call arrives', async () => {
    // An outcome about customer A, still on screen while the agent talks to
    // customer B, is worse than no message at all.
    await onCall();
    press('d');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
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

  it('does not open the dialog for a user the RBAC mirror denies', async () => {
    // `agency.dnc.write` floors at `agent`, which is level 5 — BELOW `viewer`.
    // So no role in the hierarchy lacks it, and the only denying state is a user
    // with no membership role at all. Worth knowing before someone "fixes" this
    // test by picking a lower role: there isn't one.
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: undefined });
    await onCall();
    press('d');
    expect(screen.queryByText(DNC_CONFIRM_TITLE)).toBeNull();
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain('permission');
  });
});

/**
 * `MAG-126` — the DNC result belongs to the **contact**, not to `live`.
 *
 * `released` sets `live` to null while `panelAttempt` (`live?.attempt ??
 * retainedAttempt`) keeps that same contact on screen for the whole wrap-up
 * window. Everything DNC-shaped was keyed on `live`, so the confirmation for a
 * compliance action the console had already taken vanished at hangup — at exactly
 * the moment the agent is deciding what to write in the note.
 *
 * ── Why these tests drive the button rather than `D` ─────────────────────────
 * The `press()` helper above is prophylactic **in this file**, and that is
 * measured rather than assumed: inverting the page's `inTextField` suppression so
 * that every single-key shortcut fires inside a text field leaves all of this
 * file's cases green. It fires at `document` rather than at the focused element,
 * so it cannot see that guard at all. (`AgentConsolePage.test.tsx` does catch it,
 * in the two cases written for it — the coverage exists, just not here.) A new
 * assertion routed through `press()` would therefore inherit coverage it has not
 * earned. Nothing here is about the shortcut, so nothing here goes near it —
 * `dnc-button` and the dialog's own confirm are the whole input surface.
 *
 * ── Why the deferred promise ─────────────────────────────────────────────────
 * The interesting cases are all about *when* the response lands relative to
 * `released` and `reserved`, and a `mockResolvedValue` lands whenever the
 * scheduler feels like it. `deferredDnc()` puts that ordering in the test's hands.
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

/**
 * Open the confirmation from the button and commit the DEFAULT (campaign-scoped)
 * choice. No keyboard involved. This suite is about the wrap-up/hangup lifecycle
 * of a mark already in flight, not about which of the two scopes was picked, so
 * it exercises whichever choice is reachable in every role this file uses.
 */
async function markDnc() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('dnc-button'));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: DNC_CAMPAIGN_ACTION_LABEL }));
  });
}

/** The customer hangs up with a disposition still owed — the wrap-up window. */
async function customerHangsUp() {
  await act(async () => {
    latest().emit({
      event: 'released',
      attempt_id: 'att-1',
      reason: 'completed',
      requires_disposition: true,
      message: 'Call ended.',
    });
    latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:02:00.000Z' });
  });
}

/**
 * The contact panel — the region whose contents `panelAttempt` drives.
 *
 * Named rather than reached through a bare `getByText`: the number is also on the
 * rail and inside the outcome's own sentence, so "the panel still shows this
 * contact" has to be asked of the panel.
 */
const contactPanel = () => within(screen.getByRole('region', { name: 'Contact' }));

/** The next customer arrives, which is the one event that clears the panel. */
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

describe('MAG-126 — the DNC result survives the hangup it was marked before', () => {
  it('keeps the confirmation, naming the contact it is about, through the whole wrap-up window', async () => {
    await onCall();
    await markDnc();
    await screen.findByTestId('dnc-outcome');

    await customerHangsUp();

    // (a) — and "positively identified", not "something is rendered". The
    // confirmation carries the number it is a claim about, and the panel behind
    // it is still that same contact.
    const outcome = screen.getByTestId('dnc-outcome');
    expect(outcome.textContent).toContain('+919820041772');
    expect(outcome.textContent).toContain('Do Not Call list');
    expect(contactPanel().getByText('+919820041772')).toBeTruthy();
    expect(contactPanel().getByText('Attempt 1')).toBeTruthy();
  });

  it('clears it when the next contact arrives, so wrap-up is a window and not forever', async () => {
    // (b). The sibling test above clears on a `reserved` that interrupts a live
    // call; this one goes the long way round — through `released` and a wrap-up
    // the outcome deliberately survives — so "still visible at hangup" cannot be
    // satisfied by an effect that simply never fires.
    await onCall();
    await markDnc();
    await screen.findByTestId('dnc-outcome');
    await customerHangsUp();
    expect(screen.getByTestId('dnc-outcome')).toBeTruthy();

    await nextCallArrives();

    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
    // Non-vacuous: the new contact really is on screen, so the assertion above
    // is about the outcome having been cleared and not about an empty console.
    expect(contactPanel().getByText('+919000000000')).toBeTruthy();
  });

  it('resolves a mark that was still in flight when the customer hung up', async () => {
    /**
     * (c) — **the case the one-line fix breaks.**
     *
     * Re-keying the reset effect to the panel's attempt without moving the
     * handlers' ref with it leaves all three of `.then`/`.catch`/`.finally`
     * returning early at `released`, and removes the only other thing that
     * cleared `dncInFlight`. The agent is left with a control that is disabled
     * and says "Marking…" for the whole wrap-up window, showing neither an
     * outcome nor a failure — strictly worse than the missing confirmation this
     * ticket was filed about.
     */
    const dnc = deferredDnc();
    await onCall();
    await markDnc();

    // In flight, and the console says so.
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain('Marking');

    await customerHangsUp();
    await act(async () => {
      dnc.resolve(DNC_RESPONSE);
    });

    const outcome = await screen.findByTestId('dnc-outcome');
    expect(outcome.textContent).toContain('+919820041772');
    // …and the control is released rather than wedged: the stated reason is the
    // ordinary off-call one, which is only reachable once `dncInFlight` is false
    // (`dncBlockReason` reports `in_flight` ahead of `no_live_attempt`).
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain(
      'Available while you are on a call',
    );
    expect(screen.getByTestId('dnc-disabled-reason').textContent).not.toContain('Marking');
  });

  it('reports a failure that landed after the hangup, rather than swallowing it', async () => {
    // The other half of (c): a mark the agent believes happened, which did not.
    // Silence here is the same defect as the missing confirmation, pointed the
    // more dangerous way — the agent tells the customer they are off the list.
    const dnc = deferredDnc();
    await onCall();
    await markDnc();
    await customerHangsUp();

    await act(async () => {
      dnc.reject(Object.assign(new Error('Forbidden'), { details: { code: 'unknown_attempt' } }));
    });

    const failure = await screen.findByTestId('dnc-failure');
    expect(failure.textContent).toContain('Nothing was marked');
    expect(screen.getByTestId('dnc-disabled-reason').textContent).not.toContain('Marking');
  });

  it('frees the control when the call ends owing no disposition and the mark is still in flight', async () => {
    /**
     * The other side of the reset effect, and the reason `setDncInFlight(false)`
     * stays in it.
     *
     * A `released` with `requires_disposition: false` retains nothing, so the
     * panel's attempt really does go away and the handlers really do return
     * early — this effect is the only thing left that can free the control, and
     * without it the station takes its next call with "Marking…" still on it.
     */
    const dnc = deferredDnc();
    await onCall();
    await markDnc();
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain('Marking');

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'No answer.',
      });
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:02:00.000Z' });
    });

    expect(screen.getByTestId('dnc-disabled-reason').textContent).not.toContain('Marking');

    // And the late response changes nothing: there is no contact on screen for
    // it to be about.
    await act(async () => {
      dnc.resolve(DNC_RESPONSE);
    });
    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
    expect(screen.getByTestId('dnc-disabled-reason').textContent).toContain(
      'Available while you are on a call',
    );
  });

  it('never paints the previous contact’s result onto the call that replaced them', async () => {
    /**
     * (d) — the guarantee the stale-response guard was written for, unbroken by
     * the re-key. `panelAttemptRef` still moves on `reserved`; that is now the
     * *only* thing that moves it.
     */
    const dnc = deferredDnc();
    const view = await onCall();
    await markDnc();

    await customerHangsUp();
    await nextCallArrives();

    // The response for att-1 lands while att-2 is on the line.
    await act(async () => {
      dnc.resolve(DNC_RESPONSE);
    });

    expect(screen.queryByTestId('dnc-outcome')).toBeNull();
    // Stronger than the absence of one element: the previous customer's number
    // must not appear anywhere on the console the agent is reading.
    expect(view.container.textContent ?? '').not.toContain('+919820041772');
    // Non-vacuous on both sides — att-2 is rendered, so the negative above is a
    // statement about att-1 and not about an empty page; and the control is
    // usable for the new customer, so nothing was left wedged in flight.
    expect(view.container.textContent ?? '').toContain('+919000000000');
    expect((screen.getByTestId('dnc-button') as HTMLButtonElement).disabled).toBe(false);
  });
});
