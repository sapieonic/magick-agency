import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
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
  redialFromWrapup: vi.fn(),
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
  trackAgencyRedialRequested: vi.fn(),
  trackAgencyRedialRefused: vi.fn(),
}));
vi.mock('../../analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics/events')>();
  return { ...actual, ...analyticsMocks };
});

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { PAD_REDIALING_COPY, REDIAL_REFUSAL_COPY } from '../../utils/agencyRedialCopy';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * Wrap-up redial, **at the page**: the Redial button beside the outcome pad, the
 * in-flight lock on the pad, the refusals, and the redial's own call on the same
 * screen. Every assertion goes through the rendered page on frames from a fake
 * socket, as the other console page tests do.
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

const REDIAL_ATTEMPT: AgencyReservedAttempt = {
  ...ATTEMPT,
  attempt_id: 'att-2',
  redial: { of_attempt_id: 'att-1', number: 1, remaining: 1 },
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
    { code: 'no_interest', label: 'No interest' },
  ],
  wrapup_seconds: 0,
  wrapup_auto_return: false,
  allow_wrapup_redial: true,
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

/** Shaped like the `ApiError` the client throws. */
function apiError(statusCode: number, details: unknown) {
  return Object.assign(new Error('ignored'), { statusCode, details });
}

beforeEach(() => {
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  Object.values(analyticsMocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.submitDisposition.mockResolvedValue({
    attempt_id: 'att-1',
    contact_id: 'c-1',
    disposition_code: 'sale',
    contact_state: 'completed',
    next_attempt_at: null,
    agent_state: 'wrapup',
  });
  mocks.redialFromWrapup.mockResolvedValue({
    session_id: 'sess-1',
    attempt_id: 'att-2',
    redial_of_attempt_id: 'att-1',
    redial_number: 1,
    redial_remaining: 1,
  });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  window.localStorage.clear();
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
    latest().open();
  });
  return view;
}

function wrapupFrame(attemptId: string, redial: Record<string, unknown>) {
  return {
    event: 'wrapup',
    wrapup: {
      attempt_id: attemptId,
      ends_at: null,
      requires_disposition: true,
      disposition_submitted: false,
      auto_return: false,
      held_reason: 'disposition_required',
      ...redial,
    },
  };
}

/** A connected call on `attempt` that dropped, now in a wrap-up owing its outcome. */
async function callEndsInto(attempt: AgencyReservedAttempt, redial: Record<string, unknown>, at = '10:00') {
  await act(async () => {
    latest().emit({ event: 'reserved', attempt });
    latest().emit({ event: 'agent_state', state: 'reserved', since: `2026-08-11T${at}:00.000Z` });
    latest().emit({ event: 'bridged', attempt_id: attempt.attempt_id, bridged_at: `2026-08-11T${at}:04.000Z` });
    latest().emit({ event: 'agent_state', state: 'on_call', since: `2026-08-11T${at}:04.000Z` });
    latest().emit({
      event: 'released',
      attempt_id: attempt.attempt_id,
      reason: 'remote_hangup',
      requires_disposition: true,
      message: 'Call ended.',
    });
    latest().emit({ event: 'agent_state', state: 'wrapup', since: `2026-08-11T${at}:30.000Z` });
    latest().emit(wrapupFrame(attempt.attempt_id, redial));
  });
}

async function inWrapup(redial: Record<string, unknown>) {
  const view = await mounted();
  await callEndsInto(ATTEMPT, redial);
  return view;
}

const redialButton = () => screen.queryByTestId('wrapup-redial');
const saveButton = () => screen.getByRole('button', { name: /save disposition/i }) as HTMLButtonElement;

async function pressRedial() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('wrapup-redial'));
  });
}

describe('whether Redial is offered', () => {
  it('is hidden when the wrap-up carries no redial_remaining', async () => {
    await inWrapup({});
    // The pad is up: this is a wrap-up owing an outcome, just without redial.
    await waitFor(() => expect(saveButton()).toBeTruthy());
    expect(redialButton()).toBeNull();
  });

  it('is hidden when redial_remaining is null', async () => {
    await inWrapup({ redial_remaining: null });
    expect(redialButton()).toBeNull();
  });

  it('is shown disabled at 0, saying no redials are left, and pressing it sends nothing', async () => {
    await inWrapup({ redial_remaining: 0 });
    const button = redialButton()!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('No redials left');
    await pressRedial();
    expect(mocks.redialFromWrapup).not.toHaveBeenCalled();
  });

  it('is enabled with the count when redials are left', async () => {
    await inWrapup({ redial_remaining: 2 });
    expect(redialButton()!.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('2 redials left');
  });

  it('is not shown on a live call', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    });
    expect(redialButton()).toBeNull();
  });
});

describe('pressing Redial', () => {
  it('posts the session and the wrap-up’s attempt, and reports the press', async () => {
    await inWrapup({ redial_remaining: 2 });
    await pressRedial();
    expect(mocks.redialFromWrapup).toHaveBeenCalledTimes(1);
    expect(mocks.redialFromWrapup).toHaveBeenCalledWith('sess-1', 'att-1', 'tenant-1', 'account-1');
    expect(analyticsMocks.trackAgencyRedialRequested).toHaveBeenCalledWith({
      campaign_id: 'camp-1',
      redial_remaining: 2,
    });
  });

  it('locks the button and the pad’s submit until the redial’s call arrives', async () => {
    await inWrapup({ redial_remaining: 2 });
    // An outcome picked before the press must not be saveable while it is out.
    fireEvent.click(screen.getByRole('button', { name: /Sale/ }));
    expect(saveButton().disabled).toBe(false);

    await pressRedial();

    expect(redialButton()!.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('Redialing…');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(PAD_REDIALING_COPY)).toBeTruthy();

    // A second press, and Ctrl+Enter from the notes field, both go nowhere.
    await pressRedial();
    const notes = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.keyDown(notes, { key: 'Enter', ctrlKey: true });
    });
    expect(mocks.redialFromWrapup).toHaveBeenCalledTimes(1);
    expect(mocks.submitDisposition).not.toHaveBeenCalled();
  });

  it('shows the redial’s call on the same screen: calling, connected, then its own wrap-up', async () => {
    await inWrapup({ redial_remaining: 2 });
    await pressRedial();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: REDIAL_ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:01:00.000Z' });
    });
    expect(screen.getByTestId('rail-label').textContent).toBe('Redial 1 of 2 — calling…');
    expect(screen.getByTestId('contact-redial-tag').textContent).toContain('Redial 1 of 2');
    // The wrap-up is over, so its button and its lock are gone.
    expect(redialButton()).toBeNull();

    await act(async () => {
      latest().emit({ event: 'bridged', attempt_id: 'att-2', bridged_at: '2026-08-11T10:01:04.000Z' });
      latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:01:04.000Z' });
    });
    expect(screen.getByTestId('rail-label').textContent).toBe('On call');
    expect(screen.getByTestId('rail-detail').textContent).toBe('Redial 1 of 2 · +919820041772');

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-2',
        reason: 'remote_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:02:00.000Z' });
      latest().emit(wrapupFrame('att-2', { redial_remaining: 1 }));
    });
    expect(redialButton()!.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('1 redial left');
    // The contact keeps its redial tag through its own wrap-up.
    expect(screen.getByTestId('contact-redial-tag').textContent).toContain('Redial 1 of 2');

    // And the outcome is saved on the redial's attempt.
    fireEvent.click(screen.getByRole('button', { name: /Sale/ }));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mocks.submitDisposition).toHaveBeenCalledWith(
      'att-2',
      expect.objectContaining({ disposition_code: 'sale' }),
      'tenant-1',
      'account-1',
    );
  });
});

describe('a refused redial leaves the agent in wrap-up with the pad usable', () => {
  it.each([
    ['redial_not_allowed', REDIAL_REFUSAL_COPY.redial_not_allowed],
    ['redial_limit_reached', REDIAL_REFUSAL_COPY.redial_limit_reached],
    ['disposition_already_submitted', REDIAL_REFUSAL_COPY.disposition_already_submitted],
    ['redial_blocked_dnc', REDIAL_REFUSAL_COPY.redial_blocked_dnc],
    ['redial_blocked_calling_hours', REDIAL_REFUSAL_COPY.redial_blocked_calling_hours],
    ['redial_blocked', 'Couldn’t redial: The number is not valid.'],
  ])('%s', async (code, copy) => {
    mocks.redialFromWrapup.mockRejectedValue(
      apiError(409, { error: 'Conflict', code, message: 'The number is not valid.' }),
    );
    await inWrapup({ redial_remaining: 2 });
    await pressRedial();

    await waitFor(() => expect(screen.getByTestId('wrapup-redial-refusal').textContent).toBe(copy));
    expect(screen.getByTestId('wrapup-redial-refusal').getAttribute('role')).toBe('alert');
    expect(analyticsMocks.trackAgencyRedialRefused).toHaveBeenCalledWith({ campaign_id: 'camp-1', code });

    // The limit is the one refusal that also retires the button: the frame's count is stale.
    if (code === 'redial_limit_reached') {
      expect(redialButton()!.getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('No redials left');
    } else {
      expect(redialButton()!.getAttribute('aria-disabled')).toBeNull();
      expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('2 redials left');
    }

    // The outcome can still be saved, on the call that was shown.
    fireEvent.click(screen.getByRole('button', { name: /Sale/ }));
    expect(saveButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mocks.submitDisposition).toHaveBeenCalledWith(
      'att-1',
      expect.objectContaining({ disposition_code: 'sale' }),
      'tenant-1',
      'account-1',
    );
  });

  it('says so plainly when the request itself failed, and lets the agent try again', async () => {
    mocks.redialFromWrapup.mockRejectedValueOnce(new Error('Failed to fetch'));
    await inWrapup({ redial_remaining: 1 });
    await pressRedial();
    await waitFor(() =>
      expect(screen.getByTestId('wrapup-redial-refusal').textContent).toBe(
        'Couldn’t redial. Try again, or save the outcome.',
      ),
    );
    expect(analyticsMocks.trackAgencyRedialRefused).toHaveBeenCalledWith({ campaign_id: 'camp-1', code: null });

    await pressRedial();
    expect(mocks.redialFromWrapup).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('wrapup-redial-refusal')).toBeNull();
  });
});

describe('a refreshed console brings redial back from `ready`', () => {
  it('restores the wrap-up’s Redial button from active_wrapup', async () => {
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'wrapup',
        active_wrapup: wrapupFrame('att-1', { redial_remaining: 1 }).wrapup,
      });
    });
    expect(redialButton()!.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('wrapup-redial-status').textContent).toBe('1 redial left');

    await pressRedial();
    expect(mocks.redialFromWrapup).toHaveBeenCalledWith('sess-1', 'att-1', 'tenant-1', 'account-1');
  });

  it('restores an in-progress redial’s label from active_attempt', async () => {
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: {
          ...REDIAL_ATTEMPT,
          redial: { of_attempt_id: 'att-1', number: 2, remaining: 0 },
          state: 'bridged',
          bridged_at: '2026-08-11T10:01:04.000Z',
        },
      });
    });
    expect(screen.getByTestId('rail-label').textContent).toBe('On call');
    expect(screen.getByTestId('rail-detail').textContent).toBe('Redial 2 of 2 · +919820041772');
    expect(screen.getByTestId('contact-redial-tag').textContent).toContain('Redial 2 of 2');
  });

  it('restores a ringing redial as calling', async () => {
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'reserved',
        active_attempt: { ...REDIAL_ATTEMPT, state: 'dialing', bridged_at: null },
      });
    });
    expect(screen.getByTestId('rail-label').textContent).toBe('Redial 1 of 2 — calling…');
  });
});

describe('the notes draft follows the customer onto the redial', () => {
  const notesField = () => document.getElementById('agency-notes') as HTMLTextAreaElement;
  const DRAFT = 'Dropped mid-sentence — wants the gold plan.';

  async function typeNotes(text: string) {
    await act(async () => {
      fireEvent.change(notesField(), { target: { value: text } });
    });
  }

  it('shows the first wrap-up’s text on the redial’s call and wrap-up, and submits it with the outcome', async () => {
    await inWrapup({ redial_remaining: 2 });
    await typeNotes(DRAFT);
    await pressRedial();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: REDIAL_ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:01:00.000Z' });
      latest().emit({ event: 'bridged', attempt_id: 'att-2', bridged_at: '2026-08-11T10:01:04.000Z' });
      latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:01:04.000Z' });
    });
    expect(notesField().value).toBe(DRAFT);

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-2',
        reason: 'remote_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:02:00.000Z' });
      latest().emit(wrapupFrame('att-2', { redial_remaining: 1 }));
    });
    expect(notesField().value).toBe(DRAFT);

    // Moved, the way a restored panel finds it: under the redial's key, and no
    // longer under the redialed attempt's.
    expect(JSON.parse(window.localStorage.getItem('agency.notes.att-2')!).notes).toBe(DRAFT);
    expect(window.localStorage.getItem('agency.notes.att-1')).toBeNull();
    // No request carried it: the server already holds the saved copy.
    expect(mocks.saveAttemptNotes.mock.calls.some(([req]) => req.attemptId === 'att-2')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Sale/ }));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mocks.submitDisposition).toHaveBeenCalledWith(
      'att-2',
      expect.objectContaining({ disposition_code: 'sale', notes: DRAFT }),
      'tenant-1',
      'account-1',
    );
  });

  it('carries an edit made on the redial into the second redial too', async () => {
    await inWrapup({ redial_remaining: 2 });
    await typeNotes(DRAFT);
    await pressRedial();
    await callEndsInto(REDIAL_ATTEMPT, { redial_remaining: 1 }, '10:01');
    await typeNotes(`${DRAFT} Second drop.`);

    await pressRedial();
    await act(async () => {
      latest().emit({
        event: 'reserved',
        attempt: { ...ATTEMPT, attempt_id: 'att-3', redial: { of_attempt_id: 'att-2', number: 2, remaining: 0 } },
      });
    });
    expect(notesField().value).toBe(`${DRAFT} Second drop.`);
  });

  it('starts a call that is not a redial with an empty field', async () => {
    await inWrapup({ redial_remaining: 2 });
    await typeNotes(DRAFT);

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-9', contact_id: 'c-9' } });
    });
    expect(notesField().value).toBe('');
    // The first call's draft is left where it was.
    expect(JSON.parse(window.localStorage.getItem('agency.notes.att-1')!).notes).toBe(DRAFT);
  });

  it('does not carry into a redial of some other attempt', async () => {
    await inWrapup({ redial_remaining: 2 });
    await typeNotes(DRAFT);
    await act(async () => {
      latest().emit({
        event: 'reserved',
        attempt: { ...REDIAL_ATTEMPT, redial: { of_attempt_id: 'att-other', number: 1, remaining: 1 } },
      });
    });
    expect(notesField().value).toBe('');
  });

  it('carries the draft from the local buffer when a reloaded console meets the redial in `ready`', async () => {
    window.localStorage.setItem('agency.notes.att-1', JSON.stringify({ notes: DRAFT, at: Date.now() }));
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: { ...REDIAL_ATTEMPT, state: 'bridged', bridged_at: '2026-08-11T10:01:04.000Z' },
      });
    });
    expect(notesField().value).toBe(DRAFT);
  });
});
