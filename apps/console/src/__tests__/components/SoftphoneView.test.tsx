import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  placeManualCall: vi.fn(),
  updateManualCall: vi.fn(),
  hangupManualCall: vi.fn(),
  dispositionManualCall: vi.fn(),
  markManualCallDnc: vi.fn(),
}));
vi.mock('../../api/softphone', () => api);

import { useSoftphone, SOFTPHONE_MUTED_AT_ANSWER_COPY, type SoftphoneAudio } from '../../hooks/useSoftphone';
import { SoftphoneView } from '../../components/softphone/SoftphoneView';
import { RINGING_HANGUP_WARNING } from '../../components/softphone/DialPad';
import { serverClock } from '../../hooks/useServerClock';
import type { RingbackTone } from '../../utils/softphone/ringback';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';
import { BOOTSTRAP, CAMPAIGN, manualCall, step } from '../helpers/softphone';

/**
 * The soft phone, end to end inside the browser: the dial pad (keys, typing,
 * paste), the "Log to" tag and caller ID, the override dialog, and the call's
 * life driven by `manual_call` frames — the authority — through Ready, Dialing,
 * Ringing, On call and Outcome needed, back to Ready, including a reconnect that
 * finds the call already over.
 */

function fakeRingback() {
  return {
    unlock: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    close: vi.fn(),
    playing: false,
  } as unknown as RingbackTone & Record<'unlock' | 'start' | 'stop' | 'setMuted' | 'close', ReturnType<typeof vi.fn>>;
}

const audio = { muted: false, sending: false, toggleMute: vi.fn(), resume: vi.fn() };
const clock = serverClock(0);

function Harness({
  frameCall,
  connection = 'open',
  ringback,
  presetCampaignId = null,
  audioState = audio,
}: {
  frameCall: AgencyManualCall | null;
  connection?: StationConnection;
  ringback: RingbackTone;
  presetCampaignId?: string | null;
  audioState?: SoftphoneAudio;
}) {
  const sp = useSoftphone({
    tenantId: 't-1',
    accountId: 'a-1',
    userId: 'u-1',
    sessionId: 'sess-sp',
    connection,
    frameCall,
    clock,
    audio: audioState,
    surface: 'softphone_page',
    ringback,
    presetCampaignId,
  });
  return (
    <MemoryRouter>
      <SoftphoneView sp={sp} connection={connection} clock={clock} fromCampaign={false} />
    </MemoryRouter>
  );
}

let ringback: ReturnType<typeof fakeRingback>;

async function mount(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const view = render(<Harness frameCall={null} ringback={ringback} {...props} />);
  await act(async () => {});
  return {
    ...view,
    frame: async (frameCall: AgencyManualCall | null, connection: StationConnection = 'open') => {
      view.rerender(<Harness frameCall={frameCall} ringback={ringback} connection={connection} {...props} />);
      await act(async () => {});
    },
  };
}

const rail = () => screen.getByTestId('rail-label').textContent;
const press = (key: string) => fireEvent.keyDown(window, { key });

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  audio.toggleMute.mockReset();
  audio.resume.mockReset();
  api.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
  api.listManualCalls.mockResolvedValue({
    rows: [manualCall({ id: 'old-1', state: 'ended', outcome: 'no_answer', settled_at: '2026-10-30T09:00:00Z' })],
    next_cursor: null,
    limit: 8,
  });
  api.updateManualCall.mockImplementation(async (_id: string) => ({ ok: true, value: manualCall() }));
  ringback = fakeRingback();
});

afterEach(cleanup);

describe('Ready', () => {
  it('opens on the dial pad with recent calls, the account’s default caller ID and Call disabled', async () => {
    await mount();
    expect(rail()).toBe('Ready to dial');
    expect(screen.getByTestId('recent-old-1').textContent).toMatch(/No answer · Not logged to a campaign/);
    expect((screen.getByTestId('caller-id') as HTMLSelectElement).value).toBe('+912248908888');
    expect((screen.getByTestId('dial-call') as HTMLButtonElement).disabled).toBe(true);
    // The recent list is the caller's own, whatever their role.
    expect(api.listManualCalls).toHaveBeenCalledWith({ limit: 8, agent_user_id: 'u-1' }, 't-1', 'a-1');
  });

  it('dials from the keyboard: digits type, Backspace deletes, Enter calls', async () => {
    api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall() });
    await mount();
    for (const key of '98204617334') press(key);
    press('Backspace');
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('9820461733');
    await act(async () => {
      press('Enter');
    });
    expect(api.placeManualCall).toHaveBeenCalledWith(
      { session_id: 'sess-sp', to: '9820461733', caller_id: '+912248908888', campaign_id: null },
      't-1',
      'a-1',
    );
    // The Call press is the gesture that lets the ring sound later.
    expect(ringback.unlock).toHaveBeenCalled();
    expect(audio.resume).toHaveBeenCalled();
  });

  it('dials from the pad buttons too', async () => {
    await mount();
    for (const key of '9820') fireEvent.click(screen.getByTestId(`dial-key-${key}`));
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('9820');
    expect(screen.getByTestId('dial-reason').textContent).toBe('That number is too short to call.');
  });

  it('cleans a pasted number: +91, a trunk 0, spaces', async () => {
    await mount();
    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      act(() => {
        window.dispatchEvent(event);
      });
    };
    paste('+91 98204 61733');
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+919820461733');
    paste('098204-61733');
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+919820461733');
  });

  it('reads a typed number as it will be dialled: a trunk 0 dropped beside the +91 chip, 00 as +', async () => {
    await mount();
    const field = screen.getByTestId('dial-number') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '098204 61733' } });
    expect(field.value).toBe('9820461733');
    // The chip and the field read "+91 9820461733", not "+91 09820461733".
    expect(field.parentElement!.textContent).toContain('+91');
    fireEvent.change(field, { target: { value: '' } });
    for (const key of '0044') press(key);
    expect(field.value).toBe('+44');
    // A number with its own + shows no chip.
    expect(field.parentElement!.textContent).not.toContain('+91');
  });

  it('logs to a campaign: its caller IDs, its outcomes, and the tag on the request', async () => {
    api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall({ tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name } }) });
    await mount();
    fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
    const caller = screen.getByTestId('caller-id') as HTMLSelectElement;
    expect([...caller.options].map((o) => o.value)).toEqual(CAMPAIGN.caller_ids);
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[0]![0]).toMatchObject({ campaign_id: 'camp-1', caller_id: '+912248901120' });
    // Fixed once dialled.
    expect(screen.queryByTestId('log-to-select')).toBeNull();
    expect(screen.getByTestId('log-to-fixed').textContent).toBe(CAMPAIGN.campaign_name);
  });

  it('preselects the station’s campaign as the tag (SP7)', async () => {
    await mount({ presetCampaignId: 'camp-1' });
    expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('camp-1');
  });

  it('sends the call details typed before dialling', async () => {
    api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall() });
    await mount();
    fireEvent.change(screen.getByTestId('call-field-customer_name'), { target: { value: 'Rahul Verma' } });
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[0]![0].fields).toEqual({ customer_name: 'Rahul Verma' });
  });

  it('redials a recent call into the pad and moves focus to Call, without dialling', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Redial +91 98204 61733' }));
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+919820461733');
    expect(document.activeElement).toBe(screen.getByTestId('dial-call'));
    expect(api.placeManualCall).not.toHaveBeenCalled();
  });
});

describe('refusals and overrides (SP1, SP2)', () => {
  const DNC = {
    ok: false,
    refusal: {
      code: 'dnc_listed',
      status: 409,
      message: 'Listed',
      entry: { id: 'dnc-1', scope: 'tenant', reason: 'Asked not to be called', created_at: '2026-10-12T09:00:00Z' },
    },
  };
  const HOURS = {
    ok: false,
    refusal: {
      code: 'outside_calling_hours',
      status: 409,
      message: 'Closed',
      window: { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
      timezone_source: 'campaign_default',
      next_open_at: '2026-11-02T03:30:00Z',
    },
  };

  async function dialTo(number = '9820461733') {
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: number } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
  }

  it('DNC → a dialog that says what matched → a required note → Call anyway retries with the override', async () => {
    api.placeManualCall
      .mockResolvedValueOnce(DNC)
      .mockResolvedValueOnce(HOURS)
      .mockResolvedValueOnce({ ok: true, value: manualCall() });
    await mount();
    await dialTo();

    const dialog = screen.getByTestId('override-dialog-dnc');
    expect(screen.getByRole('dialog').textContent).toMatch(/This number is on the Do Not Call list/);
    expect(dialog.textContent).toMatch(/Every campaign and account in this workspace/);
    // Typed without a country code, the number is named as dialled: with the account's.
    expect(dialog.textContent).toMatch(/Number\+91 98204 61733/);
    expect(dialog.textContent).toMatch(/Asked not to be called/);
    expect(dialog.textContent).toMatch(/12 Oct 2026/);
    // The note takes focus, and Call anyway waits for 10 characters.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('override-note')));
    const confirm = screen.getByTestId('override-confirm') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'too short' } });
    expect(confirm.disabled).toBe(true);
    expect(dialog.textContent).toMatch(/9 \/ 500/);
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'Customer rang us and asked for this call' } });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(api.placeManualCall.mock.calls[1]![0].overrides).toEqual({ dnc_note: 'Customer rang us and asked for this call' });

    // The second refusal of the same dial: a new note, and the first is kept.
    expect(screen.getByTestId('override-dialog-hours').textContent).toMatch(/09:00–20:00, Mon–Fri/);
    expect((screen.getByTestId('override-note') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'They are free only now, said so' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('override-confirm'));
    });
    expect(api.placeManualCall.mock.calls[2]![0].overrides).toEqual({
      dnc_note: 'Customer rang us and asked for this call',
      hours_note: 'They are free only now, said so',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Don’t call closes the dialog and places nothing', async () => {
    api.placeManualCall.mockResolvedValueOnce(DNC);
    await mount();
    await dialTo();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t call' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.placeManualCall).toHaveBeenCalledTimes(1);
  });

  it('a refused note comes back inside the dialog', async () => {
    api.placeManualCall
      .mockResolvedValueOnce(DNC)
      .mockResolvedValueOnce({ ok: false, refusal: { code: 'override_note_invalid', status: 400, message: 'The note needs 10 to 500 characters.' } });
    await mount();
    await dialTo();
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'Customer asked us to' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('override-confirm'));
    });
    expect(screen.getByTestId('override-error').textContent).toBe('The note needs 10 to 500 characters.');
  });

  it('dnc_unavailable is a plain error with no override', async () => {
    api.placeManualCall.mockResolvedValueOnce({ ok: false, refusal: { code: 'dnc_unavailable', status: 503, message: 'x' } });
    await mount();
    await dialTo();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('dial-error').textContent).toMatch(/couldn’t check the Do Not Call list/);
  });

  it('contact_in_flight says the campaign is calling that customer right now', async () => {
    api.placeManualCall.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'contact_in_flight', status: 409, message: 'x', campaign_id: 'camp-1', contact_id: 'c-1' },
    });
    await mount();
    fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
    await dialTo();
    expect(screen.getByTestId('dial-error').textContent).toBe(
      'Home Loan Renewals is calling this customer right now. Wait for that call to finish, then try again.',
    );
  });

  it('outcome_pending shows the call that holds the session instead of an error alone', async () => {
    api.placeManualCall.mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'outcome_pending',
        status: 409,
        message: 'x',
        call: manualCall({ id: 'mc-0', state: 'ended', requires_disposition: true, bridged_at: '2026-10-30T09:50:00Z' }),
      },
    });
    await mount();
    await dialTo();
    expect(rail()).toBe('Outcome needed');
  });
});

describe('the call, driven by manual_call frames', () => {
  it('Dialing → Ringing (ringback, SP3 warning) → On call → Outcome needed → saved → Ready', async () => {
    const queued = manualCall();
    api.placeManualCall.mockResolvedValue({ ok: true, value: queued });
    const view = await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    // The HTTP answer is enough to show the call before any frame lands.
    expect(rail()).toBe('Dialing +91 98204 61733');
    expect(document.activeElement).toBe(screen.getByTestId('softphone-body'));

    const ringing = step(queued, 2, { state: 'ringing' });
    await view.frame(ringing);
    expect(rail()).toBe('Ringing +91 98204 61733');
    expect(screen.getByTestId('ringing-warning').textContent).toBe(RINGING_HANGUP_WARNING);
    expect(ringback.start).toHaveBeenCalled();
    // Outcomes open when the customer answers, not before.
    expect(screen.getByText('Outcomes open when the customer answers.')).toBeTruthy();

    const bridged = step(queued, 8, { state: 'bridged', answered_at: '2026-10-30T10:00:07Z', bridged_at: '2026-10-30T10:00:08Z' });
    await view.frame(bridged);
    expect(rail()).toBe('On call');
    expect(ringback.stop).toHaveBeenCalled();
    // Save waits for the end of the call even with an outcome picked.
    press('1');
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Save unlocks when the call ends.');

    const ended = step(queued, 60, {
      state: 'ended',
      outcome: 'connected',
      end_reason: 'remote_hangup',
      requires_disposition: true,
      ended_at: '2026-10-30T10:01:00Z',
      talk_seconds: 52,
      bridged_at: '2026-10-30T10:00:08Z',
    });
    await view.frame(ended);
    expect(rail()).toBe('Outcome needed');
    // Required call details block the save until they are filled.
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Fill in the required call details first.');
    fireEvent.change(screen.getByTestId('call-field-customer_name'), { target: { value: 'Rahul Verma' } });
    fireEvent.change(screen.getByTestId('call-field-reason'), { target: { value: 'Rate query' } });
    expect(screen.queryByTestId('softphone-save-reason')).toBeNull();

    const settled = step(queued, 70, { ...ended, disposition_code: 'resolved', settled_at: '2026-10-30T10:01:10Z', requires_disposition: false });
    api.dispositionManualCall.mockResolvedValue({
      ok: true,
      value: { call: settled, contact_state: null, next_attempt_at: null, callback_requested_at: null },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(api.dispositionManualCall).toHaveBeenCalledWith(
      'mc-1',
      { code: 'resolved', fields: { customer_name: 'Rahul Verma', reason: 'Rate query' } },
      't-1',
      'a-1',
    );
    expect(rail()).toBe('Ready to dial');
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('');
  });

  it('notes cleared just before Save are saved cleared, not left as the old text', async () => {
    const ended = manualCall({
      state: 'ended',
      outcome: 'connected',
      end_reason: 'remote_hangup',
      requires_disposition: true,
      bridged_at: '2026-10-30T10:00:08Z',
      ended_at: '2026-10-30T10:01:00Z',
      talk_seconds: 52,
      notes: 'Wants it in writing',
      fields: { customer_name: 'Rahul Verma', reason: 'Rate query' },
    });
    api.dispositionManualCall.mockResolvedValue({
      ok: true,
      value: { call: { ...ended, disposition_code: 'resolved', settled_at: '2026-10-30T10:01:10Z' }, contact_state: null, next_attempt_at: null, callback_requested_at: null },
    });
    const view = await mount();
    await view.frame(ended);
    expect((screen.getByLabelText(/Notes/) as HTMLTextAreaElement).value).toBe('Wants it in writing');
    press('1');
    // Cleared and saved inside the 700 ms autosave window: the PATCH never goes.
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(api.updateManualCall).not.toHaveBeenCalled();
    expect(api.dispositionManualCall.mock.calls[0]![1]).toMatchObject({ code: 'resolved', notes: '' });
  });

  it('notes never touched are left out of the outcome, so the stored text is kept', async () => {
    const ended = manualCall({
      state: 'ended',
      outcome: 'connected',
      end_reason: 'remote_hangup',
      requires_disposition: true,
      bridged_at: '2026-10-30T10:00:08Z',
      ended_at: '2026-10-30T10:01:00Z',
      talk_seconds: 52,
      fields: { customer_name: 'Rahul Verma', reason: 'Rate query' },
    });
    api.dispositionManualCall.mockResolvedValue({
      ok: true,
      value: { call: { ...ended, disposition_code: 'resolved', settled_at: '2026-10-30T10:01:10Z' }, contact_state: null, next_attempt_at: null, callback_requested_at: null },
    });
    const view = await mount();
    await view.frame(ended);
    press('1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(api.dispositionManualCall.mock.calls[0]![1]).not.toHaveProperty('notes');
  });

  it('a call that was never answered goes straight back to Ready, saying how it ended', async () => {
    const view = await mount();
    await view.frame(manualCall({ state: 'ringing' }));
    await view.frame(step(manualCall(), 30, { state: 'ended', outcome: 'no_answer', end_reason: 'no_answer', settled_at: '2026-10-30T10:00:30Z' }));
    expect(rail()).toBe('Ready to dial');
    expect(screen.getByTestId('rail-detail').textContent).toMatch(/Last call to \+91 98204 61733: No answer\./);
  });

  it('hangs up with the hold gesture (E twice) on the live call', async () => {
    api.hangupManualCall.mockResolvedValue({ ok: true, value: manualCall({ state: 'ringing' }) });
    const view = await mount();
    await view.frame(manualCall({ state: 'ringing' }));
    // Two key presses are two tasks in a browser, with a render between them.
    act(() => press('e'));
    await act(async () => {
      press('e');
    });
    expect(api.hangupManualCall).toHaveBeenCalledWith('mc-1', 't-1', 'a-1');
  });

  it('marks DNC after a confirmation that says how far it reaches', async () => {
    api.markManualCallDnc.mockResolvedValue({ ok: true, value: { call_id: 'mc-1', phone_e164: '+919820461733', scope: 'tenant', dnc_recorded: true, contact_state: null } });
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    fireEvent.click(screen.getByTestId('softphone-dnc'));
    const confirm = screen.getByRole('dialog');
    expect(confirm.textContent).toMatch(/won’t be called again for the whole workspace/);
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Add to Do Not Call' }));
    });
    expect(api.markManualCallDnc).toHaveBeenCalledWith('mc-1', undefined, 't-1', 'a-1');
    expect(screen.getByTestId('softphone-dnc-outcome').textContent).toBe(
      '+91 98204 61733 is on the Do Not Call list for the whole workspace.',
    );
  });

  it('autosaves the notes onto the live call', async () => {
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'Wants it in writing' } });
    await waitFor(() => expect(api.updateManualCall).toHaveBeenCalled(), { timeout: 2000 });
    expect(api.updateManualCall.mock.calls[0]![1]).toEqual({ fields: {}, notes: 'Wants it in writing' });
  });
});

describe('the outcome window', () => {
  it('says when an unsaved outcome closes', async () => {
    const view = await mount();
    const due = new Date(Date.now() + 90_500).toISOString();
    await view.frame(
      step(manualCall(), 60, {
        state: 'ended',
        outcome: 'connected',
        end_reason: 'remote_hangup',
        requires_disposition: true,
        ended_at: '2026-10-30T10:01:00Z',
        bridged_at: '2026-10-30T10:00:08Z',
        talk_seconds: 52,
        outcome_due_at: due,
      }),
    );
    expect(rail()).toBe('Outcome needed');
    expect(screen.getByTestId('outcome-closes').textContent).toMatch(
      /^Dialing is blocked until this call has an outcome\. Closes in 1:(29|30) — then it closes with no outcome\.$/,
    );
  });
});

describe('keys on a focused select', () => {
  it('a digit typed into the caller ID’s select is the select’s, not the number’s', async () => {
    await mount();
    const caller = screen.getByTestId('caller-id');
    caller.focus();
    fireEvent.keyDown(caller, { key: '9' });
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(window, { key: '9' });
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('9');
  });

  it('a digit typed into a choice field does not pick an outcome', async () => {
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    const reason = screen.getByTestId('call-field-reason');
    reason.focus();
    fireEvent.keyDown(reason, { key: '1' });
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Pick an outcome to save this call.');
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Save unlocks when the call ends.');
  });
});

describe('the ringback', () => {
  it('is closed, not just stopped, when the soft phone goes away', async () => {
    const view = await mount();
    expect(ringback.close).not.toHaveBeenCalled();
    view.unmount();
    expect(ringback.close).toHaveBeenCalled();
  });
});

describe('mute', () => {
  const ringing = step(manualCall(), 2, { state: 'ringing' });
  const bridged = step(manualCall(), 8, { state: 'bridged', answered_at: '2026-10-30T10:00:07Z', bridged_at: '2026-10-30T10:00:08Z' });
  const muteButton = () => screen.getByTestId('softphone-mute') as HTMLButtonElement;

  it('while ringing, Mute silences the ringback only — the microphone is left alone', async () => {
    const view = await mount();
    await view.frame(ringing);
    expect(muteButton().textContent).toMatch(/^Mute ring/);
    expect(muteButton().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(muteButton());
    expect(ringback.setMuted).toHaveBeenLastCalledWith(true);
    expect(muteButton().textContent).toMatch(/^Unmute ring/);
    expect(muteButton().getAttribute('aria-pressed')).toBe('true');

    press('m');
    expect(ringback.setMuted).toHaveBeenLastCalledWith(false);
    expect(audio.toggleMute).not.toHaveBeenCalled();
  });

  it('once audio flows Mute is the microphone’s again, and a muted ring does not carry into the call', async () => {
    const view = await mount();
    await view.frame(ringing);
    fireEvent.click(muteButton());
    view.rerender(<Harness frameCall={bridged} ringback={ringback} audioState={{ ...audio, sending: true }} />);
    await act(async () => {});
    expect(muteButton().textContent).toMatch(/^Mute/);
    expect(muteButton().textContent).not.toMatch(/ring/);
    expect(muteButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(muteButton());
    expect(audio.toggleMute).toHaveBeenCalledTimes(1);
  });

  it('says so, assertively, when the call is answered with the microphone muted', async () => {
    const mutedMic = { ...audio, muted: true, sending: true };
    const view = render(<Harness frameCall={ringing} ringback={ringback} audioState={mutedMic} />);
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('');
    view.rerender(<Harness frameCall={bridged} ringback={ringback} audioState={mutedMic} />);
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(SOFTPHONE_MUTED_AT_ANSWER_COPY);
  });
});

describe('reconnect', () => {
  it('re-reads the bootstrap and retires a call that ended while the socket was away', async () => {
    const view = await mount();
    const live = manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' });
    await view.frame(live);
    expect(rail()).toBe('On call');
    await view.frame(live, 'reconnecting');
    expect(rail()).toBe('Reconnecting');
    api.getSoftphoneBootstrap.mockResolvedValueOnce({ ...BOOTSTRAP, call: null });
    await view.frame(live, 'open');
    expect(api.getSoftphoneBootstrap).toHaveBeenCalledTimes(2);
    expect(rail()).toBe('Ready to dial');
  });

  it('shows the live call again when the bootstrap still holds it', async () => {
    const view = await mount();
    await view.frame(null, 'reconnecting');
    api.getSoftphoneBootstrap.mockResolvedValueOnce({
      ...BOOTSTRAP,
      call: manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z', notes: 'From before the drop' }),
    });
    await view.frame(null, 'open');
    expect(rail()).toBe('On call');
    expect((screen.getByLabelText(/Notes/) as HTMLTextAreaElement).value).toBe('From before the drop');
  });
});
