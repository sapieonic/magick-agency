import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react';

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

import { SOFTPHONE_MUTED_AT_ANSWER_COPY } from '../../hooks/useSoftphone';
import { callFromHint } from '../../components/softphone/StationSoftphone';
import { SIDE_COPY } from '../../utils/agency/sideViewCopy';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import type { AgencyManualCall } from '../../types/softphone';
import { BOOTSTRAP, CAMPAIGN, manualCall, step } from '../helpers/softphone';
import { Harness, audio, fakeRingback, mount as mountSoftphone, type HarnessProps } from '../helpers/softphoneHarness';

/**
 * The soft phone, end to end inside the browser: the dial pad (keys, typing,
 * paste), the "Log to" tag and caller ID, the override dialog, and the call's
 * life driven by `manual_call` frames — the authority — through Ready, Dialing,
 * Ringing, On call and Outcome needed, back to Ready, including a reconnect that
 * finds the call already over.
 */

let ringback: ReturnType<typeof fakeRingback>;

const mount = (props: Partial<Omit<HarnessProps, 'frameCall'>> = {}) => mountSoftphone({ ringback, ...props });

const rail = () => screen.getByTestId('band-title').textContent;
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

describe('the customer card follows the call’s campaign’s number setting (AS19 S3(b))', () => {
  const bootstrapWith = (phoneDisplay: 'full' | 'masked' | undefined) => ({
    ...BOOTSTRAP,
    taggable_campaigns: [{
      ...CAMPAIGN,
      context_display: { roles: { name: 'Name' }, types: { 'Alt phone': 'phone' }, facts: [{ column: 'Alt phone', label: 'Other number', key: 'alt_phone' }] },
      ...(phoneDisplay ? { phone_display: phoneDisplay } : {}),
    }],
  });
  const onCall = (view: Awaited<ReturnType<typeof mount>>) => view.frame(manualCall({
    state: 'bridged',
    tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name },
    contact: { contact_id: 'c-1', state: 'in_flight', claimed: true, context: { Name: 'Rahul Verma', 'Alt phone': '9876512345' } },
    answered_at: '2026-10-30T10:00:05Z',
    bridged_at: '2026-10-30T10:00:05Z',
  }));

  it('masks a phone fact when the call’s campaign hides numbers, on a page with no station campaign; the dialled number stays as typed', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(bootstrapWith('masked'));
    // `/dialer/phone` passes `full` for the frame: the call's campaign decides, not the frame.
    const view = await mount({ phoneDisplay: 'full' });
    await onCall(view);
    const card = screen.getByTestId('customer-card');
    expect(within(card).getByTestId('customer-name').textContent).toBe('Rahul Verma');
    expect(within(card).getByTestId('customer-fact').getAttribute('aria-label')).toBe('Other number: 98••• ••345');
    expect(card.textContent).not.toContain('98765');
    expect(within(card).getByTestId('customer-phone').textContent).toBe('+91 98204 61733');
  });

  for (const setting of ['full', undefined] as const) {
    it(`shows a phone fact whole when the call’s campaign ${setting ? 'shows numbers' : 'sends no setting'}, whatever the station shows`, async () => {
      api.getSoftphoneBootstrap.mockResolvedValue(bootstrapWith(setting));
      const view = await mount({ presetCampaignId: 'camp-1', phoneDisplay: 'masked' });
      await onCall(view);
      const card = screen.getByTestId('customer-card');
      expect(within(card).getByTestId('customer-fact').getAttribute('aria-label')).toBe('Other number: +91 98765 12345');
    });
  }
});

// docs/call-log.md §5: the account's "Every call must belong to a campaign", as the bootstrap says it
// (`campaign_required`). In the station's words (AS15): a campaign is "work".
describe('every call must be saved to a work', () => {
  const REQUIRED = { ...BOOTSTRAP, campaign_required: true };
  const type = (number: string) => fireEvent.change(screen.getByTestId('dial-number'), { target: { value: number } });
  const select = () => screen.getByTestId('log-to-select') as HTMLSelectElement;

  it('asks for one: "(required)", no "Not in any work" to choose, and Call stays off until one is chosen', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall() });
    await mount();
    expect(screen.getByTestId('log-to-required').textContent).toContain('(required)');
    expect([...select().options].map((o) => o.textContent)).toEqual(['Choose the work', 'Home Loan Renewals']);
    expect(select().required).toBe(true);
    expect(screen.queryByText('Not in any work', { selector: 'option' })).toBeNull();

    type('9820461733');
    expect(screen.getByTestId('dial-call').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('dial-reason').textContent).toBe('Choose the work to save this call to.');
    // Enter does not dial either.
    await act(async () => {
      press('Enter');
    });
    expect(api.placeManualCall).not.toHaveBeenCalled();

    fireEvent.change(select(), { target: { value: 'camp-1' } });
    expect(screen.getByTestId('dial-call').getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall).toHaveBeenCalledWith(expect.objectContaining({ to: '9820461733', campaign_id: 'camp-1' }), 't-1', 'a-1');
  });

  it('with the rule off, "Not in any work" is still the first choice and a call can go without one', async () => {
    await mount();
    expect(screen.queryByTestId('log-to-required')).toBeNull();
    expect([...select().options].map((o) => o.textContent)).toEqual(['Not in any work', 'Home Loan Renewals']);
    type('9820461733');
    expect(screen.getByTestId('dial-call').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('an agent in no work that is running cannot dial: the pad gives way to what to do', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue({ ...REQUIRED, taggable_campaigns: [] });
    await mount();
    const card = screen.getByTestId('softphone-no-work');
    expect(card.textContent).toBe('You are not in any work that is running, so you cannot dial.Ask your supervisor to add you to one.');
    expect(screen.queryByTestId('dial-card')).toBeNull();
    expect(screen.queryByTestId('log-to-select')).toBeNull();
  });

  it('a supervisor with no work running is told there is none, not to ask a supervisor', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue({ ...REQUIRED, taggable_campaigns: [] });
    await mount({ supervises: true });
    expect(screen.getByTestId('softphone-no-work').textContent).toBe('No work is running in this account, so no call can be made.');
    expect(screen.queryByTestId('dial-card')).toBeNull();
  });

  // A Missed call's Call back fills the pad as a redial does.
  it('a Call back of a call saved to no work, or to one that cannot be chosen, leaves the box empty and says why', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    await mount({ presetNumber: '+919820461733', presetCampaignId: 'camp-gone' });
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+919820461733');
    expect(select().value).toBe('');
    expect(screen.getByTestId('log-to-note').textContent).toBe('This call was not saved to any work. Choose one to call again.');
    fireEvent.change(select(), { target: { value: 'camp-1' } });
    expect(screen.queryByTestId('log-to-note')).toBeNull();
  });

  it('a Call back of a call saved to a work the agent can choose keeps it, with no line; nor is there one while the rule is off', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    await mount({ presetNumber: '+919820461733', presetCampaignId: 'camp-1' });
    expect(select().value).toBe('camp-1');
    expect(screen.queryByTestId('log-to-note')).toBeNull();
    cleanup();
    api.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
    await mount({ presetNumber: '+919820461733', presetCampaignId: null });
    expect(screen.queryByTestId('log-to-note')).toBeNull();
  });

  it('a redial of a call saved to no work leaves the box empty and says why; choosing one clears the line', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    await mount();
    fireEvent.click(screen.getByTestId('recent-old-1').querySelector('button')!);
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+919820461733');
    expect(select().value).toBe('');
    expect(screen.getByTestId('log-to-note').textContent).toBe('This call was not saved to any work. Choose one to call again.');
    expect(screen.getByTestId('dial-call').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(select(), { target: { value: 'camp-1' } });
    expect(screen.queryByTestId('log-to-note')).toBeNull();
  });

  it('a redial of a call saved to a work the agent can still choose keeps it, with no line', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    api.listManualCalls.mockResolvedValue({
      rows: [manualCall({ id: 'old-2', state: 'ended', outcome: 'no_answer', settled_at: '2026-10-30T09:00:00Z', tag: { campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals' } })],
      next_cursor: null,
      limit: 8,
    });
    await mount();
    fireEvent.click(screen.getByTestId('recent-old-2').querySelector('button')!);
    expect(select().value).toBe('camp-1');
    expect(screen.queryByTestId('log-to-note')).toBeNull();
  });

  it('the rule switched on under an open page: the server\'s refusal is said in the station\'s words and the pad reads it again', async () => {
    api.placeManualCall.mockResolvedValue({
      ok: false,
      refusal: { code: 'campaign_required', status: 409, message: 'Choose a campaign before you dial. Every call in this account must belong to a campaign.' },
    });
    await mount();
    type('9820461733');
    api.getSoftphoneBootstrap.mockResolvedValue(REQUIRED);
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(screen.getByTestId('dial-error').textContent).toBe('Choose the work to save this call to, then press Call.');
    await waitFor(() => expect(screen.getByTestId('log-to-required')).toBeTruthy());
  });
});

describe('Ready', () => {
  it('opens on the dial pad with recent calls, the account’s default caller ID and Call disabled', async () => {
    await mount();
    expect(rail()).toBe('Dial a number');
    expect(screen.getByTestId('recent-old-1').textContent).toMatch(/No answer · Not in any work/);
    expect((screen.getByTestId('caller-id') as HTMLSelectElement).value).toBe('+912248908888');
    // Call stays in place, faded, until there is a number to call.
    expect(screen.getByTestId('dial-call').getAttribute('aria-disabled')).toBe('true');
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
    expect(screen.getByTestId('dial-reason').textContent).toBe('This number is too short.');
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

  it('a double-click on Call places one call', async () => {
    let answer: (value: unknown) => void = () => {};
    api.placeManualCall.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    const call = screen.getByTestId('dial-call');
    // Both presses land before React renders the first one's "Calling…": the
    // guard cannot be the disabled button alone.
    act(() => {
      fireEvent.click(call);
      fireEvent.click(call);
    });
    // And a second press once it has rendered.
    act(() => {
      fireEvent.click(call);
      press('Enter');
    });
    await act(async () => {
      answer({ ok: true, value: manualCall() });
    });
    expect(api.placeManualCall).toHaveBeenCalledTimes(1);
  });

  it('logs to a campaign: Automatic, then its caller IDs, and the tag on the request', async () => {
    api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall({ tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name } }) });
    await mount();
    fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
    const caller = screen.getByTestId('caller-id') as HTMLSelectElement;
    expect([...caller.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Automatic'],
      ...CAMPAIGN.caller_ids.map((id) => [id, formatDialNumber(id)]),
    ]);
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[0]![0]).toMatchObject({ campaign_id: 'camp-1' });
    // Fixed once dialled.
    expect(screen.queryByTestId('log-to-select')).toBeNull();
    expect(screen.getByTestId('log-to-fixed').textContent).toBe(CAMPAIGN.campaign_name);
  });

  describe('Call from on a tagged call (DN4)', () => {
    const tagged = (over: Partial<AgencyManualCall> = {}) =>
      manualCall({ tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name }, ...over });
    const caller = () => screen.getByTestId('caller-id') as HTMLSelectElement;

    it('defaults to Automatic and sends no caller_id: the server picks the number', async () => {
      api.placeManualCall.mockResolvedValue({ ok: true, value: tagged() });
      await mount();
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
      expect(caller().value).toBe('');
      expect(caller().selectedOptions[0]!.textContent).toBe('Automatic');
      expect(screen.getByTestId('caller-id-hint').textContent).toBe(SIDE_COPY.automaticHint);
      fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('dial-call'));
      });
      const body = api.placeManualCall.mock.calls[0]![0];
      expect(body).toEqual({ session_id: 'sess-sp', to: '9820461733', campaign_id: 'camp-1' });
      expect('caller_id' in body).toBe(false);
    });

    it('a number the agent picks is sent; picking Automatic again takes it off', async () => {
      api.placeManualCall.mockResolvedValue({ ok: true, value: tagged({ caller_id: '+912248901121' }) });
      await mount();
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
      fireEvent.change(caller(), { target: { value: '+912248901121' } });
      expect(caller().value).toBe('+912248901121');
      expect(screen.getByTestId('caller-id-hint').textContent).toBe(
        'One of Home Loan Renewals’s numbers. If the customer has their own agent’s number, the call goes from that one.',
      );
      expect(SIDE_COPY.pickedHintWork(CAMPAIGN.campaign_name)).toBe(screen.getByTestId('caller-id-hint').textContent);
      fireEvent.change(caller(), { target: { value: '' } });
      expect(screen.getByTestId('caller-id-hint').textContent).toBe(SIDE_COPY.automaticHint);
      fireEvent.change(caller(), { target: { value: '+912248901121' } });
      fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('dial-call'));
      });
      expect(api.placeManualCall.mock.calls[0]![0]).toEqual({
        session_id: 'sess-sp', to: '9820461733', caller_id: '+912248901121', campaign_id: 'camp-1',
      });
    });

    it('a picked number’s hint only while the setup is editable: none once Call is pressed', async () => {
      let answer: (value: unknown) => void = () => {};
      api.placeManualCall.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await mount();
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
      fireEvent.change(caller(), { target: { value: '+912248901121' } });
      expect(screen.getByTestId('caller-id-hint').textContent).toBe(SIDE_COPY.pickedHintWork(CAMPAIGN.campaign_name));
      fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
      // In flight: the pick is no longer the agent's to change, so no "wins / gives way".
      act(() => {
        fireEvent.click(screen.getByTestId('dial-call'));
      });
      expect(screen.queryByTestId('caller-id-hint')).toBeNull();
      await act(async () => {
        answer({ ok: true, value: tagged({ caller_id: '+912248901121' }) });
      });
      expect(screen.queryByTestId('caller-id-hint')).toBeNull();
    });

    it('callerIdHint: none for a placed call, whose number is final; the pick’s while editing', () => {
      const campaign = CAMPAIGN;
      // A placed tagged call: Automatic is off and the setup fixed (useSoftphone).
      expect(callFromHint({ callerIdAutomatic: false, callerId: '+912248901121', setupEditable: false, campaign })).toBeNull();
      expect(callFromHint({ callerIdAutomatic: false, callerId: '+912248901121', setupEditable: true, campaign }))
        .toBe(SIDE_COPY.pickedHintWork(CAMPAIGN.campaign_name));
      expect(callFromHint({ callerIdAutomatic: true, callerId: null, setupEditable: true, campaign })).toBe(SIDE_COPY.automaticHint);
    });

    it('once placed, shows the number the server dialled, not the draft', async () => {
      // Automatic on the request; the contact's owner's dedicated number on the call.
      api.placeManualCall.mockResolvedValue({ ok: true, value: tagged({ caller_id: '+912248901121' }) });
      await mount();
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
      fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('dial-call'));
      });
      expect(within(screen.getByTestId('calling-from')).getByText(formatDialNumber('+912248901121'))).toBeTruthy();
    });

    it('back to untagged, the account’s default returns and no Automatic is offered', async () => {
      api.placeManualCall.mockResolvedValue({ ok: true, value: manualCall() });
      await mount();
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
      fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: '' } });
      expect(caller().value).toBe('+912248908888');
      expect([...caller().options].map((o) => o.value)).toEqual(BOOTSTRAP.untagged.caller_ids);
      expect(screen.getByTestId('caller-id-hint').textContent).toBe(SIDE_COPY.pickedHintOwn);
      fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('dial-call'));
      });
      expect(api.placeManualCall.mock.calls[0]![0]).toEqual({
        session_id: 'sess-sp', to: '9820461733', caller_id: '+912248908888', campaign_id: null,
      });
    });

    it('a redial goes out from the number it went from, tagged or untagged', async () => {
      api.listManualCalls.mockResolvedValue({
        rows: [
          manualCall({
            id: 'old-t', destination_e164: '+919820461733', caller_id: '+912248901121', state: 'ended',
            outcome: 'no_answer', settled_at: '2026-10-30T09:00:00Z',
            tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name },
          }),
          manualCall({
            id: 'old-u', destination_e164: '+919820461744', caller_id: '+912248909999', state: 'ended',
            outcome: 'no_answer', settled_at: '2026-10-30T08:00:00Z',
          }),
        ],
        next_cursor: null,
        limit: 8,
      });
      await mount();
      fireEvent.click(screen.getByRole('button', { name: /^Put \+91 98204 61733 in/ }));
      expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('camp-1');
      expect(caller().value).toBe('+912248901121');
      fireEvent.click(screen.getByRole('button', { name: /^Put \+91 98204 61744 in/ }));
      expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('');
      expect(caller().value).toBe('+912248909999');
    });
  });

  it('says a closed window is the campaign’s time, which the customer’s own may not share', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, taggable_campaigns: [{ ...CAMPAIGN, calling_window_open: false }] });
    await mount();
    fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
    expect(screen.getByTestId('window-closed-hint').textContent).toBe(SIDE_COPY.outsideHours);
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

  it('a Missed call’s Call back fills the pad and the campaign, focuses Call, and dials nothing', async () => {
    await mount({ presetNumber: '+447700900123', presetCampaignId: 'camp-1' });
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+447700900123');
    expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('camp-1');
    expect(document.activeElement).toBe(screen.getByTestId('dial-call'));
    expect(api.placeManualCall).not.toHaveBeenCalled();
  });

  it('a Call back’s dial names the missed call it answers, once, and only while the pad still holds that number (CL1)', async () => {
    const MISSED = '8f2c1d2e-1111-4222-8333-444455556666';
    api.placeManualCall.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 502, message: 'no' } });
    await mount({ presetNumber: '+447700900123', presetCallbackOf: MISSED });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[0]![0]).toMatchObject({ to: '+447700900123', callback_of_inbound_call_id: MISSED });
    // The agent rings someone else from the same pad: that call is no call back.
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[1]![0]).not.toHaveProperty('callback_of_inbound_call_id');
  });

  it('a pad filled without a missed call sends no link', async () => {
    api.placeManualCall.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 502, message: 'no' } });
    await mount({ presetNumber: '+447700900123' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(api.placeManualCall.mock.calls[0]![0]).not.toHaveProperty('callback_of_inbound_call_id');
  });

  it('a Call back for a campaign the agent cannot log to leaves the call untagged', async () => {
    await mount({ presetNumber: '+447700900123', presetCampaignId: 'not-mine' });
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+447700900123');
    expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('');
  });

  it('a Call back waits for a call still live or owing its outcome, and fills the pad once it settles', async () => {
    const live = manualCall({ destination_e164: '+919820461733', state: 'answered' });
    api.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, call: live });
    const view = await mount({ presetNumber: '+447700900123' });
    expect(screen.queryByTestId('dial-number')).toBeNull();
    await view.frame(manualCall({
      destination_e164: '+919820461733', state: 'ended', outcome: 'connected', settled_at: '2099-01-01T00:00:00Z', updated_at: '2099-01-01T00:00:00Z',
    }));
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('+447700900123');
    expect(document.activeElement).toBe(screen.getByTestId('dial-call'));
    expect(api.placeManualCall).not.toHaveBeenCalled();
  });

  it('redials a recent call into the pad and moves focus to Call, without dialling', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /^Put \+91 98204 61733 in/ }));
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
    expect(screen.getByRole('dialog').textContent).toMatch(/This customer asked us not to call them/);
    expect(dialog.textContent).toMatch(/Not to be called forAll our work/);
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

  it('Don’t call is the primary action and Call anyway the secondary one', async () => {
    api.placeManualCall.mockResolvedValueOnce(DNC);
    await mount();
    await dialTo();
    expect(screen.getByRole('button', { name: 'Don’t call' }).className).toBe('btn-primary');
    expect(screen.getByTestId('override-confirm').className).toBe('btn-secondary');
  });

  it('a campaign entry an untagged call met is named as one of the account’s lists', async () => {
    api.placeManualCall.mockResolvedValueOnce({ ...DNC, refusal: { ...DNC.refusal, entry: { ...DNC.refusal.entry, scope: 'campaign' } } });
    await mount();
    await dialTo();
    expect(screen.getByTestId('override-dialog-dnc').textContent).toMatch(/Not to be called forOne of this account’s lists/);
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
      .mockResolvedValueOnce({ ok: false, refusal: { code: 'override_note_invalid', status: 400, message: 'Server: note invalid' } });
    await mount();
    await dialTo();
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'Customer asked us to' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('override-confirm'));
    });
    // The station's words, never the server's sentence (AS15).
    expect(screen.getByTestId('override-error').textContent).toBe('Write a note of 10 to 500 letters.');
  });

  it('fields_invalid at Call marks the fields the server named, either path form', async () => {
    api.placeManualCall.mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'fields_invalid',
        status: 400,
        message: 'x',
        details: [
          { path: 'fields.customer_name', message: 'At most 200 characters.' },
          { path: 'reason', message: 'Not one of the choices.' },
        ],
      },
    });
    await mount();
    await dialTo();
    expect(screen.getByTestId('dial-error').textContent).toBe(
      'Some call details need fixing. They are marked in Call details.',
    );
    const name = screen.getByTestId('call-field-customer_name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)!.textContent).toContain('At most 200 characters.');
    expect(screen.getByTestId('call-field-reason').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('call-field-follow_up').getAttribute('aria-invalid')).toBeNull();
  });

  it('dnc_unavailable is a plain error with no override', async () => {
    api.placeManualCall.mockResolvedValueOnce({ ok: false, refusal: { code: 'dnc_unavailable', status: 503, message: 'x' } });
    await mount();
    await dialTo();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('dial-error').textContent).toMatch(/could not check the do-not-call list/);
  });

  it('contact_in_flight says another call to that customer is going on now', async () => {
    api.placeManualCall.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'contact_in_flight', status: 409, message: 'x', campaign_id: 'camp-1', contact_id: 'c-1' },
    });
    await mount();
    fireEvent.change(screen.getByTestId('log-to-select'), { target: { value: 'camp-1' } });
    await dialTo();
    expect(screen.getByTestId('dial-error').textContent).toBe(
      'Another call to this customer is going on now. Wait for it to end, then try again.',
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
    expect(rail()).toBe('What happened?');
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
    expect(rail()).toBe('Calling +91 98204 61733');
    expect(document.activeElement).toBe(screen.getByTestId('station-body'));

    const ringing = step(queued, 2, { state: 'ringing', can_cancel_ringing: false });
    await view.frame(ringing);
    expect(rail()).toBe('Calling +91 98204 61733');
    expect(screen.getByTestId('ringing-warning').textContent).toBe(SIDE_COPY.ringingWarning);
    expect(ringback.start).toHaveBeenCalled();
    // What happened? opens when the call ends; nothing to choose from while it rings.
    expect(screen.queryByTestId('outcome-tiles')).toBeNull();

    const bridged = step(queued, 8, { state: 'bridged', answered_at: '2026-10-30T10:00:07Z', bridged_at: '2026-10-30T10:00:08Z' });
    await view.frame(bridged);
    expect(rail()).toBe('On call');
    expect(ringback.stop).toHaveBeenCalled();
    // A key picks on the call; Save waits for its end: End call is the one main button now.
    press('1');
    expect(screen.queryByTestId('softphone-save')).toBeNull();

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
    expect(rail()).toBe('What happened?');
    // The pick made on the call is kept.
    expect(screen.getByTestId('outcome-resolved').getAttribute('aria-pressed')).toBe('true');
    // Required call details block the save until they are filled: Save says so, and sends nothing.
    fireEvent.click(screen.getByTestId('softphone-save'));
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Fill in the call details first.');
    expect(api.dispositionManualCall).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('call-field-customer_name'), { target: { value: 'Rahul Verma' } });
    fireEvent.change(screen.getByTestId('call-field-reason'), { target: { value: 'Rate query' } });

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
    expect(rail()).toBe('Dial a number');
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('');
  });

  it('SP3: no hang-up warning while ringing on a carrier that can stop a ringing call', async () => {
    const queued = manualCall();
    api.placeManualCall.mockResolvedValue({ ok: true, value: queued });
    const view = await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    await view.frame(step(queued, 2, { state: 'ringing', can_cancel_ringing: true }));
    expect(rail()).toBe('Calling +91 98204 61733');
    expect(screen.queryByTestId('ringing-warning')).toBeNull();
  });

  it('SP3: a ringing call that does not say its carrier can stop it is warned about (fails closed)', async () => {
    const queued = manualCall();
    api.placeManualCall.mockResolvedValue({ ok: true, value: queued });
    const view = await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    const ringing = step(queued, 2, { state: 'ringing' });
    expect(ringing).not.toHaveProperty('can_cancel_ringing');
    await view.frame(ringing);
    expect(screen.getByTestId('ringing-warning').textContent).toBe(SIDE_COPY.ringingWarning);
  });

  it('the ringing hang-up warning names no carrier', () => {
    expect(SIDE_COPY.ringingWarning).toMatch(/phone may keep ringing/);
    expect(SIDE_COPY.ringingWarning).not.toMatch(/voicelink|plivo|carrier/i);
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
    expect((screen.getByRole('textbox', { name: /note/i }) as HTMLTextAreaElement).value).toBe('Wants it in writing');
    press('1');
    // Cleared and saved inside the 700 ms autosave window: the PATCH never goes.
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: '' } });
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
    expect(rail()).toBe('Dial a number');
    expect(screen.getByTestId('softphone-last-call').textContent).toBe('Last call to +91 98204 61733: No answer.');
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
    // An untagged call's mark is account-scoped (docs/softphone.md §6), never workspace-wide.
    api.markManualCallDnc.mockResolvedValue({ ok: true, value: { call_id: 'mc-1', phone_e164: '+919820461733', scope: 'account', dnc_recorded: true, contact_state: null } });
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    press('d');
    const confirm = screen.getByTestId('stop-calling');
    expect(confirm.textContent).toMatch(/We will not call this number again for any work in this account\./);
    await act(async () => {
      fireEvent.click(within(confirm).getByTestId('stop-calling-yes'));
    });
    expect(api.markManualCallDnc).toHaveBeenCalledWith('mc-1', undefined, 't-1', 'a-1');
    expect(screen.getByTestId('softphone-dnc-outcome').textContent).toBe('We will not call this number again.');
  });

  it('D opens the same Mark DNC confirmation, only once a call is placed', async () => {
    const view = await mount();
    press('d');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByTestId('dial-number') as HTMLInputElement).value).toBe('');
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    press('d');
    expect(screen.getByTestId('stop-calling').textContent).toMatch(/Stop calling this customer\?/);
    expect(api.markManualCallDnc).not.toHaveBeenCalled();
  });

  it('one main button bottom right (AS1): End call held on the call, Save once it ends', async () => {
    const view = await mount();
    const foot = () => [...(document.querySelector('footer')?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('data-testid') ?? b.textContent ?? '');
    expect(foot()).toEqual([]);
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    expect(foot().at(-1)).toMatch(/Hold to end call/);
    await view.frame(step(manualCall(), 60, { state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z', ended_at: '2026-10-30T10:01:00Z' }));
    expect(foot().at(-1)).toBe('softphone-save');
    expect(screen.queryByRole('button', { name: /Hold to end call/ })).toBeNull();
  });

  it('autosaves the notes onto the live call', async () => {
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }));
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: 'Wants it in writing' } });
    await waitFor(() => expect(api.updateManualCall).toHaveBeenCalled(), { timeout: 2000 });
    expect(api.updateManualCall.mock.calls[0]![1]).toEqual({ fields: {}, notes: 'Wants it in writing' });
  });
});

describe('finish mode: the soft phone turned off for the account', () => {
  const OFF = { ...BOOTSTRAP, softphone_enabled: false };
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

  it('keeps the live call, its hang-up and its outcome, and says no new calls can start', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(OFF);
    api.hangupManualCall.mockResolvedValue({ ok: true, value: manualCall({ state: 'bridged' }) });
    api.dispositionManualCall.mockResolvedValue({
      ok: true,
      value: { call: { ...ended, disposition_code: 'resolved', settled_at: '2026-10-30T10:01:10Z' }, contact_state: null, next_attempt_at: null, callback_requested_at: null },
    });
    const view = await mount();
    await view.frame(manualCall({ state: 'bridged', bridged_at: '2026-10-30T10:00:08Z', fields: ended.fields }));
    expect(screen.getByTestId('softphone-finish-notice').textContent).toBe(
      'The soft phone is turned off. Finish this call and save it. You cannot dial new calls.',
    );
    act(() => press('e'));
    await act(async () => {
      press('e');
    });
    expect(api.hangupManualCall).toHaveBeenCalledWith('mc-1', 't-1', 'a-1');

    await view.frame(ended);
    press('1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(api.dispositionManualCall).toHaveBeenCalled();
    // Settled, in finish mode: no number field to land on, so focus is the body's.
    expect(screen.getByTestId('softphone-finish-notice').textContent).toMatch(/You cannot dial new calls/);
    expect(document.activeElement).toBe(screen.getByTestId('station-body'));
  });

  it('once nothing is left to finish there is no dial pad: no number field, keypad, Call or redial', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue(OFF);
    await mount();
    expect(screen.getByTestId('softphone-finish-notice').textContent).toBe(
      'The soft phone is turned off. You cannot dial new calls. Close the soft phone when you are done.',
    );
    expect(screen.queryByTestId('dial-number')).toBeNull();
    expect(screen.queryByTestId('dial-key-1')).toBeNull();
    expect(screen.queryByTestId('dial-call')).toBeNull();
    for (const key of '9820461733') press(key);
    press('Enter');
    expect(api.placeManualCall).not.toHaveBeenCalled();
    // Nothing that starts a call is offered: no choices, no recent calls to put back.
    expect(screen.queryByRole('button', { name: /^Put \+91 98204 61733 in/ })).toBeNull();
    expect(screen.queryByTestId('log-to')).toBeNull();
  });

  it('a host that knows the flag is off starts in finish mode before any bootstrap says so', async () => {
    let answer: (b: unknown) => void = () => {};
    api.getSoftphoneBootstrap.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness frameCall={null} ringback={ringback} startAllowed={false} />);
    expect(screen.getByTestId('softphone-finish-notice')).toBeTruthy();
    await act(async () => answer(BOOTSTRAP));
    expect(screen.getByTestId('softphone-finish-notice')).toBeTruthy();
  });

  it('a dial refused softphone_disabled (turned off under an open page) switches to finish mode and re-reads', async () => {
    api.placeManualCall.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    api.getSoftphoneBootstrap.mockResolvedValue(OFF);
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(screen.getByTestId('softphone-finish-notice')).toBeTruthy();
    expect(screen.queryByTestId('dial-call')).toBeNull();
    expect(api.getSoftphoneBootstrap).toHaveBeenCalledTimes(2);
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
    expect(rail()).toBe('What happened?');
    expect(screen.getByTestId('softphone-outcome-due-digits').textContent).toMatch(/^1:(29|30)$/);
    expect(screen.getByTestId('softphone-outcome-due').textContent).toMatch(/If you do not choose, this call closes at \d{1,2}:\d\d (AM|PM)\./);
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
    const ended = step(manualCall(), 60, { state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z', ended_at: '2026-10-30T10:01:00Z' });
    await view.frame(ended);
    const reason = screen.getByTestId('call-field-reason');
    reason.focus();
    fireEvent.keyDown(reason, { key: '1' });
    expect(screen.getByTestId('outcome-resolved').getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByTestId('outcome-resolved').getAttribute('aria-pressed')).toBe('true');
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
    expect(rail()).toBe('Call problem');
    api.getSoftphoneBootstrap.mockResolvedValueOnce({ ...BOOTSTRAP, call: null });
    await view.frame(live, 'open');
    expect(api.getSoftphoneBootstrap).toHaveBeenCalledTimes(2);
    expect(rail()).toBe('Dial a number');
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
    expect((screen.getByRole('textbox', { name: /note/i }) as HTMLTextAreaElement).value).toBe('From before the drop');
  });
});

describe('a tagged call whose campaign can no longer be tagged', () => {
  it('keeps its campaign’s outcomes after a reload (bootstrap’s call_campaign), so the first save is accepted', async () => {
    // The campaign completed mid-call: it left `taggable_campaigns`, and the reloaded
    // console must not fall back to the untagged catalog, which the server refuses.
    const owed = manualCall({
      tag: { campaign_id: CAMPAIGN.campaign_id, campaign_name: CAMPAIGN.campaign_name },
      state: 'ended', outcome: 'connected', end_reason: 'remote_hangup', requires_disposition: true,
      bridged_at: '2026-10-30T10:00:08Z', ended_at: '2026-10-30T10:01:00Z', talk_seconds: 52,
    });
    api.getSoftphoneBootstrap.mockResolvedValue({
      ...BOOTSTRAP, call_fields: [], taggable_campaigns: [], call: owed,
      call_campaign: { ...CAMPAIGN, status: 'completed' },
    });
    api.dispositionManualCall.mockResolvedValue({
      ok: true,
      value: { call: { ...owed, disposition_code: 'interested', requires_disposition: false, settled_at: '2026-10-30T10:01:10Z' },
        contact_state: null, next_attempt_at: null, callback_requested_at: null },
    });
    await mount();
    expect(rail()).toBe('What happened?');
    expect(screen.getByText('Interested, renewing')).toBeTruthy();
    expect(screen.queryByText('Query resolved')).toBeNull();
    press('1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(api.dispositionManualCall).toHaveBeenCalledWith('mc-1', expect.objectContaining({ code: 'interested' }), 't-1', 'a-1');
  });
});

describe('promise outcomes need a contact the call claimed (PT13)', () => {
  const PTP_CAMPAIGN = {
    ...CAMPAIGN,
    disposition_catalog: [
      ...CAMPAIGN.disposition_catalog,
      { code: 'ptp', label: 'Promised to pay', requires_promise: true, promise_follow_up_days: 2 },
    ],
  };
  const owed = (contact: AgencyManualCall['contact']) => manualCall({
    tag: { campaign_id: CAMPAIGN.campaign_id, campaign_name: CAMPAIGN.campaign_name }, contact,
    state: 'ended', outcome: 'connected', end_reason: 'remote_hangup', requires_disposition: true,
    bridged_at: '2026-10-30T10:00:08Z', ended_at: '2026-10-30T10:01:00Z', talk_seconds: 52,
  });

  it.each([
    ['no roster contact', null],
    ['a contact the call only linked', { contact_id: 'ct-1', state: 'completed' as const, claimed: false }],
  ])('hides them on a tagged call with %s', async (_name, contact) => {
    api.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, call_fields: [], taggable_campaigns: [PTP_CAMPAIGN], call: owed(contact) });
    await mount();
    expect(rail()).toBe('What happened?');
    expect(screen.getByText('Interested, renewing')).toBeTruthy();
    expect(screen.queryByText('Promised to pay')).toBeNull();
  });

  it('offers them on a call that claimed its contact', async () => {
    api.getSoftphoneBootstrap.mockResolvedValue({
      ...BOOTSTRAP, call_fields: [], taggable_campaigns: [PTP_CAMPAIGN],
      call: owed({ contact_id: 'ct-1', state: 'in_flight', claimed: true }),
    });
    await mount();
    expect(screen.getByText('Promised to pay')).toBeTruthy();
  });
});
