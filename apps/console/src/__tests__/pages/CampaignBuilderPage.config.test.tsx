import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { assertFieldAnnouncesError } from '../helpers/a11y';
import {
  applied,
  currentStep,
  fillBasics,
  goToStep,
  openFold,
  renderPage,
  saveDraftButton,
  staffingHook,
} from './campaignBuilderFixtures';

/**
 * The settings at the PAGE level, as an operator meets them on Purpose & buttons and Agents &
 * timing (the same editors campaign Settings uses, under each step's Advanced fold), and what
 * Save as draft sends.
 *
 * (a) built-in codes cannot be deleted in the UI and the reason is explained inline; (b) server
 * validation errors map to the offending field.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  isCapabilityEnabled: vi.fn(),
  trackConfigSaved: vi.fn(),
  useCallAnalysisProfiles: vi.fn(),
  applyStaffing: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyCampaignConfigSaved: mocks.trackConfigSaved,
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isCapabilityEnabled, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: mocks.useCallAnalysisProfiles,
}));
// The caller-ID picker is a hard gate on this page: The API rejects a campaign with
// an empty `caller_ids`, so nothing downstream runs until one is chosen.
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+912200000001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        label: 'Outbound 1',
        is_default: true,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
vi.mock('../../hooks/useCampaignStaffing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useCampaignStaffing')>()),
  useCampaignStaffing: () => staffingHook(mocks.applyStaffing),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: vi.fn(),
}));

const PROFILES = [
  { id: 'prof-default', name: 'Standard summary', is_default: true },
  { id: 'prof-collections', name: 'Collections dimensions', is_default: false },
];

/** Purpose & buttons, with its Advanced fold (the full outcome editor) open. */
async function openButtons() {
  await renderPage();
  fillBasics();
  goToStep('Purpose & buttons');
  openFold('purpose-advanced');
}

/** Agents & timing, with its Advanced fold open when asked. */
async function openAgents({ advanced = false }: { advanced?: boolean } = {}) {
  await renderPage();
  fillBasics();
  goToStep('Agents & timing');
  if (advanced) openFold('advanced-settings');
}

/** Agents & timing with Custom hours: the start, end and time zone fields. */
async function openCustomHours() {
  await openAgents();
  fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
}

const save = () => fireEvent.click(saveDraftButton());
const sent = (call = 0) => mocks.updateAgencyCampaign.mock.calls[call]![1] as Record<string, any>;

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.isCapabilityEnabled.mockReturnValue(true);
  mocks.useCallAnalysisProfiles.mockReturnValue({ profiles: PROFILES, loading: false, error: null });
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.applyStaffing.mockResolvedValue(applied());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the disposition catalog editor (Purpose & buttons › Advanced)', () => {
  it('renders the three built-ins with Remove disabled and the reason beside it', async () => {
    await openButtons();
    for (const code of ['voicemail', 'callback', 'do_not_call']) {
      expect(screen.getByTestId(`lock-${code}`)).toBeTruthy();
    }
    // (a): not merely disabled — a lock with no reason reads as a permissions bug.
    expect(screen.getByTestId('lock-callback').textContent).toContain('schedule a call for later');
    expect((screen.getByRole('button', { name: 'Remove Callback' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders outcomes, because the order is the agent’s number key', async () => {
    await openButtons();
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Voicemail');

    fireEvent.click(screen.getByRole('button', { name: 'Move Callback up' }));

    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Callback');
    expect((screen.getByLabelText('Outcome 2 label') as HTMLInputElement).value).toBe('Voicemail');
    // The ends stay put rather than wrapping round.
    expect((screen.getByRole('button', { name: 'Move Callback up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('fills the code in from the label until the operator writes one', async () => {
    await openButtons();
    fireEvent.click(screen.getByRole('button', { name: 'Add an outcome' }));

    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay' } });
    expect((screen.getByLabelText('Outcome 4 code') as HTMLInputElement).value).toBe('promised_to_pay');

    // A hand-typed code detaches permanently — renaming must not overwrite it.
    fireEvent.change(screen.getByLabelText('Outcome 4 code'), { target: { value: 'ptp' } });
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay soon' } });
    expect((screen.getByLabelText('Outcome 4 code') as HTMLInputElement).value).toBe('ptp');
  });

  /**
   * The regression this pins is invisible to a one-shot `fireEvent.change` with the finished
   * string. The list key used to embed `entry.code`; because a new outcome's code follows its
   * label, every keystroke changed the key, React remounted the card and the field being typed
   * into was destroyed along with the caret — one character per click into the box.
   */
  it('survives being typed into one character at a time, caret and all', async () => {
    await openButtons();
    fireEvent.click(screen.getByRole('button', { name: 'Add an outcome' }));

    const field = () => screen.getByLabelText('Outcome 4 label') as HTMLInputElement;
    // The row is focused on arrival, so the operator can just start typing.
    expect(document.activeElement).toBe(field());

    const node = field();
    for (const value of ['S', 'Sa', 'Sal', 'Sale']) {
      fireEvent.change(field(), { target: { value } });
      // Same DOM node throughout: a remount would hand back a different one.
      expect(field()).toBe(node);
      expect(document.activeElement).toBe(node);
    }

    expect(field().value).toBe('Sale');
    expect((screen.getByLabelText('Outcome 4 code') as HTMLInputElement).value).toBe('sale');
  });

  it('shows a built-in code as a locked chip rather than a text box that refuses typing', async () => {
    await openButtons();
    expect(screen.getByTestId('lock-callback').textContent).toContain('schedule a call for later');
    expect(screen.queryByLabelText('Outcome 2 code')).toBeNull();
  });

  it('says what the combination of flags actually does, not just which are on', async () => {
    await openButtons();
    // Voicemail: the default entry's own retry rule.
    expect(screen.getByTestId('outcome-summary-0').textContent).toContain('every 4 hours, up to 2 times');
    expect(screen.getByTestId('outcome-summary-2').textContent).toContain('suppressed');
    expect(screen.getByTestId('outcome-summary-1').textContent).toContain('pick a date and time to call back');
  });

  it('warns when Ends is set beside Stops, which the API never reaches', async () => {
    await openButtons();
    expect(screen.queryByTestId('precedence-2')).toBeNull();

    // `do_not_call` already carries `suppress`; adding `terminal` is legal and saves, and is also
    // unreachable — the API returns on the suppress arm.
    const dncFlags = screen.getByRole('group', { name: 'What happens when an agent files Do not call' });
    fireEvent.click(within(dncFlags).getByRole('checkbox', { name: /Ends this contact/ }));

    expect(screen.getByTestId('precedence-2').textContent).toContain('adds nothing');
  });

  it('offers the disposition’s own retry, and withdraws it where the API cannot read it', async () => {
    await openButtons();
    const voicemailFlags = screen.getByRole('group', { name: 'What happens when an agent files Voicemail' });
    const voicemail = within(voicemailFlags.closest('li')!);
    expect(
      (voicemail.getByRole('checkbox', { name: /Call this contact again after this outcome/ }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Voicemail retry attempts'), { target: { value: '4' } });
    expect(screen.getByTestId('outcome-summary-0').textContent).toContain('up to 4 times');

    // Ending the contact makes the rule unreachable, so the control goes and the reason takes its
    // place rather than a dead input staying on screen.
    fireEvent.click(within(voicemailFlags).getByRole('checkbox', { name: /Ends this contact/ }));
    expect(screen.queryByLabelText('Voicemail retry attempts')).toBeNull();
    expect(screen.getByTestId('retry-inert-0').textContent).toContain('nothing will act on it');
  });

  it('lets an operator add and remove a custom outcome', async () => {
    await openButtons();
    fireEvent.click(screen.getByRole('button', { name: 'Add an outcome' }));

    fireEvent.change(screen.getByLabelText('Outcome 4 code'), { target: { value: 'promised_to_pay' } });
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay' } });

    const remove = screen.getByRole('button', { name: 'Remove Promised to pay' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(screen.queryByLabelText('Outcome 4 code')).toBeNull();
  });
});

describe('wrap-up (Agents & timing)', () => {
  const wrapupSelect = () => screen.getByRole('combobox', { name: 'Time to choose what happened after each call' }) as HTMLSelectElement;
  const autoReturn = () =>
    screen.getByRole('checkbox', { name: /send agents back to the pool automatically/i }) as HTMLInputElement;

  /**
   * `wrapup_auto_return` decides whether an agent's shift is paced by a timer or by them: on,
   * the countdown returns them to the pool; off, they sit in wrap-up until they say they are
   * ready.
   */
  it('offers the auto return under Advanced and sends it on save', async () => {
    await openAgents({ advanced: true });
    // The API's own column default, so a new campaign starts where it always did.
    expect(autoReturn().checked).toBe(true);

    fireEvent.click(autoReturn());
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().wrapup_auto_return).toBe(false);
  });

  it('sends the time picked for “What happened?”', async () => {
    await openAgents();
    fireEvent.change(wrapupSelect(), { target: { value: '45' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().wrapup_seconds).toBe(45);
  });

  it('offers “Allow redial from wrap-up”, off by default, and sends it on save', async () => {
    await openAgents({ advanced: true });
    const box = screen.getByRole('checkbox', { name: /allow redial from wrap-up/i }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('allow-wrapup-redial-hint').textContent).toContain('up to 2 times');

    fireEvent.click(box);
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().allow_wrapup_redial).toBe(true);
  });

  it('sends the redial setting as false when it is left off', async () => {
    await openAgents();
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().allow_wrapup_redial).toBe(false);
  });

  it('says what each setting means for an agent, not just that it is on', async () => {
    await openAgents({ advanced: true });
    expect(screen.getByTestId('auto-return-hint').textContent).toContain('on their own');
    fireEvent.click(autoReturn());
    expect(screen.getByTestId('auto-return-hint').textContent).toContain('mark themselves ready');
  });

  it('says the flag is inert with no wrap-up window, rather than greying it out', async () => {
    // The API only starts a countdown when there is BOTH a window and the flag, so at 0 the
    // checkbox is stored but does nothing. Disabling it would discard the operator's choice the
    // moment they set the window back.
    await openAgents({ advanced: true });
    fireEvent.change(wrapupSelect(), { target: { value: '0' } });

    expect(screen.getByTestId('auto-return-hint').textContent).toContain('no countdown');
    expect(autoReturn().disabled).toBe(false);
  });
});

describe('the abandonment limit (Agents & timing › Advanced)', () => {
  /*
    Every campaign pauses itself past `abandonment_ceiling_pct`. The builder's first save is a
    create and then a PATCH, so the value has to ride on the PATCH, whether or not it was touched.
  */
  const slider = () => screen.getByRole('slider', { name: 'Abandonment limit' });

  it('is at 3%, and sends 3 when left alone', async () => {
    await openAgents({ advanced: true });
    expect(slider().getAttribute('aria-valuenow')).toBe('3');
    expect((screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement).value).toBe('3');

    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().abandonment_ceiling_pct).toBe(3);
  });

  it('sends the value the line was moved to', async () => {
    await openAgents({ advanced: true });
    fireEvent.keyDown(slider(), { key: 'PageUp' });
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().abandonment_ceiling_pct).toBe(4.1);
  });

  it('blocks the save on an out-of-range value', async () => {
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pause above (%)' }), { target: { value: '15' } });

    expect(screen.getByTestId('config-block')).toBeTruthy();
    expect(saveDraftButton().disabled).toBe(true);
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('lands a server refusal on the field, on Agents & timing with Advanced open', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation Error'), {
        statusCode: 400,
        details: { details: { abandonment_ceiling_pct: 'Must be above 0 and at most 100.' } },
      }),
    );
    await renderPage();
    fillBasics();
    goToStep('Purpose & buttons');
    save();

    const box = await screen.findByRole('spinbutton', { name: 'Pause above (%)' });
    expect(currentStep()).toBe('agents');
    expect((screen.getByTestId('advanced-settings') as HTMLDetailsElement).open).toBe(true);
    assertFieldAnnouncesError(box.id, 'Must be above 0 and at most 100.');

    // A refusal is about the value it came with: moving the line retires it.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Abandonment limit' }), { key: 'ArrowRight' });
    expect(screen.queryByText('Must be above 0 and at most 100.')).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('the retry policy editor (Agents & timing › Advanced)', () => {
  it('shows invalid and connected as fixed at zero WITH the reason, not hidden', async () => {
    await openAgents({ advanced: true });
    // Hiding them invites the operator to assume they retry.
    expect(screen.getByTestId('fixed-invalid').textContent).toContain('does not become valid');
    expect(screen.getByTestId('fixed-connected').textContent).toContain('agent');
    expect(screen.queryByLabelText('Invalid number max attempts')).toBeNull();
  });

  it('previews a configured rule in English', async () => {
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByLabelText('Busy delay in minutes'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Busy max attempts'), { target: { value: '4' } });

    expect(screen.getByTestId('retry-previews').textContent).toContain('Busy: retried every 15 minutes, up to 4 times.');
  });

  it('explains that voicemail retry lives on the disposition, not here', async () => {
    await openAgents({ advanced: true });
    expect(screen.getByTestId('voicemail-retry-callout').textContent).toContain('voicemail disposition');
  });

  it('offers an editable `agent_disconnected` row, labelled as our fault', async () => {
    await openAgents({ advanced: true });
    // Editable, not fixed-at-zero: the API genuinely honours a configured cap.
    expect(screen.getByLabelText('Agent disconnected (our fault) max attempts')).toBeTruthy();
    expect(screen.queryByTestId('fixed-agent_disconnected')).toBeNull();
  });

  it('does NOT offer an `orphaned` row — the API never reads a campaign value for it', async () => {
    // A control that saves, persists and reloads while changing nothing is worse than no control.
    await openAgents({ advanced: true });
    expect(screen.queryByLabelText('Orphaned by a restart (our fault) max attempts')).toBeNull();
  });

  it('does not zero the platform bound when only the DELAY is typed', async () => {
    /*
     * The row seed was `{ max_attempts: 0 }`, so touching only the delay box submitted
     * `max_attempts: 0` the operator never typed — and the API reads
     * `min(configured, OUR_FAULT_REDIAL_BOUND)`, retiring the contact on its FIRST pre-connect
     * agent drop. Never dialled again.
     */
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) delay in minutes'), { target: { value: '7' } });
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const rule = sent().retry_policy.agent_disconnected;
    expect(rule.delay_minutes).toBe(7);
    expect(rule.max_attempts).toBe(3);
  });

  it('warns on the row when the operator really does set 0', async () => {
    await openAgents({ advanced: true });
    expect(screen.queryByTestId('our-fault-zero-agent_disconnected')).toBeNull();
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) max attempts'), { target: { value: '0' } });
    expect(screen.getByTestId('our-fault-zero-agent_disconnected').textContent).toMatch(/retires the contact permanently/);
  });

  it('sends a configured `agent_disconnected` cap on save', async () => {
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) delay in minutes'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) max attempts'), { target: { value: '3' } });
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().retry_policy.agent_disconnected).toEqual({ delay_minutes: 5, max_attempts: 3 });
  });

  it('says the bound can be lowered here, and what lowering it to 0 costs', async () => {
    await openAgents({ advanced: true });
    const callout = screen.getByTestId('our-fault-retry-callout').textContent!;
    expect(callout).toContain('Our fault');
    expect(callout).toMatch(/only LOWER it here, never raise it/);
    expect(callout).toMatch(/retires that contact for good/);
    expect(callout.toLowerCase()).not.toContain('smaller');
  });

  it('offers an editable `canceled` row, labelled as our fault', async () => {
    await openAgents({ advanced: true });
    expect(screen.getByLabelText('Stopped by us before answer (our fault) max attempts')).toBeTruthy();
    expect(screen.queryByTestId('fixed-canceled')).toBeNull();
  });

  it('does not zero the bound when only the DELAY is typed on the `canceled` row', async () => {
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByLabelText('Stopped by us before answer (our fault) delay in minutes'), { target: { value: '10' } });
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const rule = sent().retry_policy.canceled;
    expect(rule.delay_minutes).toBe(10);
    expect(rule.max_attempts).toBe(3);
  });

  it('warns on the `canceled` row when the operator really does set 0', async () => {
    await openAgents({ advanced: true });
    expect(screen.queryByTestId('our-fault-zero-canceled')).toBeNull();
    fireEvent.change(screen.getByLabelText('Stopped by us before answer (our fault) max attempts'), { target: { value: '0' } });
    expect(screen.getByTestId('our-fault-zero-canceled').textContent).toMatch(/retires the contact permanently/);
  });

  it('names BOTH our-fault failures in the one shared callout', async () => {
    await openAgents({ advanced: true });
    const callout = screen.getByTestId('our-fault-retry-callout').textContent!;
    expect(callout).toContain('agent-side drop');
    expect(callout).toContain('before anyone picked up');
  });
});

describe('calling hours (Agents & timing)', () => {
  it('offers the hours as choices, today’s default picked, and sends a choice', async () => {
    await openAgents();
    expect((screen.getByRole('radio', { name: '9 AM – 8 PM' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 9 PM' }));
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().calling_window_start).toBe('09:00');
    expect(sent().calling_window_end).toBe('21:00');
  });

  it('echoes a custom window in plain English', async () => {
    await openCustomHours();
    const echo = screen.getByTestId('calling-window-echo').textContent!;
    expect(echo).toContain('09:00–20:00');
    expect(echo).toContain('Asia/Kolkata');
  });

  it('re-echoes an inverted window as the operator types it', async () => {
    // The echo exists because a pair of time inputs cannot show an inverted range. It has to be
    // live, or it only catches the mistake on save.
    await openCustomHours();
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '06:00' } });
    expect(screen.getByTestId('calling-window-echo').textContent).toContain('overnight');
  });

  it('displays the concurrency limit without offering a control', async () => {
    await openCustomHours();
    const note = screen.getByTestId('concurrency-note');
    expect(note.textContent).toContain('shared with your AI calls');
    expect(note.textContent).toContain('Contact support');
    // No input, no stepper, no Edit link — a greyed-out control reads as "you lack permission
    // today" and produces a support ticket with no resolution.
    expect(note.querySelector('input')).toBeNull();
    expect(note.querySelector('button')).toBeNull();
    expect(note.querySelector('a')).toBeNull();
  });
});

describe('validation', () => {
  it('blocks the save on a client-side finding and says why', async () => {
    await openCustomHours();
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } });

    expect(screen.getByTestId('config-block')).toBeTruthy();
    expect(saveDraftButton().disabled).toBe(true);
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('sends the whole config, including an empty retry policy', async () => {
    await renderPage();
    fillBasics();
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const body = sent();
    expect(body.calling_days).toEqual([1, 2, 3, 4, 5]);
    expect(body.default_timezone).toBe('Asia/Kolkata');
    expect(body.retry_policy).toEqual({});
    expect(body.disposition_catalog.map((entry: { code: string }) => entry.code)).toEqual([
      'voicemail',
      'callback',
      'do_not_call',
    ]);
  });
});

describe('the campaign a builder actually creates', () => {
  /**
   * The campaign table declares no `description` column and its update whitelist does not list
   * it, so the field wrote nothing.
   */
  it('offers no Description field', async () => {
    await renderPage();
    expect(screen.queryByLabelText(/description/i)).toBeNull();
  });

  it('sends no `description` key on create', async () => {
    await renderPage();
    fillBasics();
    save();

    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    // The whole body, not just the absent key.
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toEqual({
      name: 'Collections',
      caller_ids: ['+912200000001'],
      telephony_provider: 'voicelink',
      // The service's own carrier account: no tenant credential.
      telephony_credential_id: null,
      // The create carries the limit too (see the roster-first case in CampaignBuilderPage.test.tsx).
      abandonment_ceiling_pct: 3,
    });
  });
});

describe('the agent screen and break limits (Agents & timing)', () => {
  /*
    The same campaign PATCH campaign Settings saves them with takes them, so New campaign sends
    each one that moved from the server's default, and nothing for one left alone.
  */
  it('sends nothing for the daily target, number display or breaks when left alone', async () => {
    await openAgents();
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('daily_target_calls');
    expect(sent()).not.toHaveProperty('phone_display');
    expect(sent()).not.toHaveProperty('break_reasons');
  });

  it('sends a daily target, the number hidden and a break limit once set', async () => {
    await openAgents({ advanced: true });
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '40' } });
    fireEvent.click(within(screen.getByTestId('phone-display-row')).getByRole('switch'));
    fireEvent.change(screen.getByLabelText('Limit for Tea, in minutes'), { target: { value: '10' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().daily_target_calls).toBe(40);
    expect(sent().phone_display).toBe('masked');
    const tea = (sent().break_reasons as Array<{ code: string; limit_minutes?: number }>).find((r) => r.code === 'tea');
    expect(tea?.limit_minutes).toBe(10);
  });

  it('holds the save on a daily target out of range or a break limit out of range', async () => {
    await openAgents();
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '0' } });
    expect(saveDraftButton().disabled).toBe(true);
    expect(screen.getByTestId('config-block').textContent).toContain('Fix the highlighted field to save.');
    fireEvent.change(screen.getByTestId('daily-target'), { target: { value: '' } });
    expect(saveDraftButton().disabled).toBe(false);

    openFold('advanced-settings');
    fireEvent.change(screen.getByLabelText('Limit for Tea, in minutes'), { target: { value: '999' } });
    expect(saveDraftButton().disabled).toBe(true);
    // The fold that holds it stays open.
    expect((screen.getByTestId('advanced-settings') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('call recording (Agents & timing)', () => {
  const recordSwitch = () => within(screen.getByTestId('record-row')).getByRole('switch') as HTMLButtonElement;

  it('is offered, off by default, and sent as record_calls on save', async () => {
    await openAgents();
    expect(recordSwitch().getAttribute('aria-checked')).toBe('false');
    expect(recordSwitch().disabled).toBe(false);

    fireEvent.click(recordSwitch());
    expect(screen.getByTestId('record-row').textContent).toMatch(/Make sure agents tell customers/);
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().record_calls).toBe(true);
  });

  it('sends record_calls: false when left off, so the saved value is explicit', async () => {
    await openAgents();
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().record_calls).toBe(false);
  });

  it('locks the switch and says why when the account may not record', async () => {
    mocks.isCapabilityEnabled.mockImplementation((key: string) => key !== 'agency.recording');
    await openAgents();

    expect(recordSwitch().disabled).toBe(true);
    expect(screen.getByTestId('record-row').textContent).toContain('Call recording is turned off for this account');
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Off is always allowed, so it is still sent.
    expect(sent().record_calls).toBe(false);
  });

  it('shows the API refusal in words and returns to the step with the switch', async () => {
    // The governance map can be stale; the API's 403 is the real answer.
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('capability_disabled'), {
        statusCode: 403,
        details: { error: 'capability_disabled', capability: 'agency.recording' },
      }),
    );
    await openAgents();
    fireEvent.click(recordSwitch());
    goToStep('Purpose & buttons');
    save();

    const banner = await screen.findByTestId('builder-error');
    expect(banner.textContent).toContain('Call recording is turned off for this account (agency.recording)');
    expect(screen.queryByText(/^capability_disabled$/)).toBeNull();
    expect(currentStep()).toBe('agents');
    expect(recordSwitch()).toBeTruthy();
  });

  it('clears the refusal once a later save succeeds', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('capability_disabled'), {
        statusCode: 403,
        details: { error: 'capability_disabled', capability: 'agency.recording' },
      }),
    );
    await openAgents();
    fireEvent.click(recordSwitch());
    save();
    await screen.findByTestId('builder-error');

    fireEvent.click(recordSwitch()); // back off
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalledTimes(2));
    expect(sent(1).record_calls).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('builder-error')).toBeNull());
  });
});

describe('the call summary (Agents & timing)', () => {
  const summarySelect = () => screen.getByRole('combobox', { name: 'Call summary' }) as HTMLSelectElement;

  it('offers the account’s profiles and sends the one picked on save', async () => {
    await openAgents();
    expect(mocks.useCallAnalysisProfiles).toHaveBeenCalledWith({ enabled: true });
    expect([...summarySelect().options].map((o) => o.textContent)).toEqual([
      'No summary',
      'Standard summary (default)',
      'Collections dimensions',
    ]);
    expect(summarySelect().value).toBe('__none__');

    fireEvent.change(summarySelect(), { target: { value: 'prof-collections' } });
    expect(screen.getByTestId('summary-row').textContent).toContain('Each connected call is summarised');
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().analysis_profile_id).toBe('prof-collections');
    expect(mocks.trackConfigSaved).toHaveBeenCalledWith(expect.objectContaining({ source: 'builder', analysis_profile_set: true }));
  });

  it('sends an explicit null when left at No summary', async () => {
    await openAgents();
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().analysis_profile_id).toBeNull();
    expect(mocks.trackConfigSaved).toHaveBeenCalledWith(expect.objectContaining({ analysis_profile_set: false }));
  });

  it('is locked with its reason, and no profile is sent, when the account may not summarise calls', async () => {
    mocks.isCapabilityEnabled.mockImplementation((key: string) => key !== 'agency.analytics');
    await openAgents();

    expect(summarySelect().disabled).toBe(true);
    expect(screen.getByTestId('summary-row').textContent).toContain('Call summaries are turned off for this account');
    expect(mocks.useCallAnalysisProfiles).toHaveBeenCalledWith({ enabled: false });
    save();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Clearing is always allowed, so `null` passes the API's guard with the capability off.
    expect(sent().analysis_profile_id).toBeNull();
  });

  it('says when the profiles could not be loaded, and still saves without one', async () => {
    mocks.useCallAnalysisProfiles.mockReturnValue({ profiles: [], loading: false, error: 'Network down' });
    await openAgents();

    const row = screen.getByTestId('summary-row').textContent!;
    expect(row).toContain('Could not load your summary profiles (Network down)');
    expect(row).toContain('set it later in the campaign’s Settings');
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sent().analysis_profile_id).toBeNull();
  });

  it('turns a profile the account no longer has into words, on the step with the picker', async () => {
    // The API's error mask leaves a codeless 404 when the profile is gone.
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Something went wrong'), {
        statusCode: 404,
        details: { error: 'Request Failed', message: 'Something went wrong' },
      }),
    );
    await openAgents();
    fireEvent.change(summarySelect(), { target: { value: 'prof-collections' } });
    goToStep('Purpose & buttons');
    save();

    const banner = await screen.findByTestId('builder-error');
    expect(banner.textContent).toContain('That call-summary profile is no longer available');
    expect(currentStep()).toBe('agents');
    expect(summarySelect()).toBeTruthy();
  });

  it('shows the server’s refusal of the profile on the field', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation failed'), {
        statusCode: 400,
        details: { error: 'Validation failed', details: { analysis_profile_id: 'must be a call-analysis profile id, or null to clear it' } },
      }),
    );
    await openAgents();
    fireEvent.change(summarySelect(), { target: { value: 'prof-collections' } });
    save();

    expect(await screen.findByText('must be a call-analysis profile id, or null to clear it')).toBeTruthy();
    expect(summarySelect().getAttribute('aria-invalid')).toBe('true');
  });
});

describe('the Payment reminder starting point (the Collections set, AS4, CS2)', () => {
  async function pickPayment() {
    await renderPage();
    fillBasics();
    goToStep('Purpose & buttons');
    fireEvent.click(screen.getByRole('radio', { name: /Payment reminder/ }));
  }

  it('shows the six as their tiles are labelled, in the agent’s view', async () => {
    const { AGENCY_COLLECTIONS_STARTER_CATALOG } = await import('@magick-agency/contracts/agency');
    await pickPayment();
    const preview = screen.getByTestId('agent-buttons-preview').textContent ?? '';
    for (const entry of AGENCY_COLLECTIONS_STARTER_CATALOG) expect(preview).toContain(entry.label);
  });

  it('reports a reorder against the set as applied, not the outcomes it replaced', async () => {
    await pickPayment();
    save();
    await waitFor(() => expect(mocks.trackConfigSaved).toHaveBeenCalledTimes(1));
    expect(mocks.trackConfigSaved.mock.calls[0]![0]).toMatchObject({ reordered: false });

    fireEvent.click(screen.getByRole('button', { name: 'Move the Will pay button down' }));
    save();
    await waitFor(() => expect(mocks.trackConfigSaved).toHaveBeenCalledTimes(2));
    expect(mocks.trackConfigSaved.mock.calls[1]![0]).toMatchObject({ reordered: true });
  });

  it('replaces the outcomes with the six, each with its picture, editable, and saves them', async () => {
    const { AGENCY_COLLECTIONS_STARTER_CATALOG } = await import('@magick-agency/contracts/agency');
    await pickPayment();
    openFold('purpose-advanced');

    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Will pay');
    expect((screen.getByLabelText('Outcome 6 label') as HTMLInputElement).value).toBe("Don't call again");
    expect(screen.queryByLabelText('Outcome 7 label')).toBeNull();
    expect(screen.getByTestId('outcome-icon-0').getAttribute('aria-label')).toBe('Picture for Will pay: Rupee');

    // Still a starting point: rename one before saving.
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Will not pay' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const catalog = sent().disposition_catalog as Array<Record<string, unknown>>;
    expect(catalog).toEqual(AGENCY_COLLECTIONS_STARTER_CATALOG.map((entry) => (
      entry.code === 'refused' ? { ...entry, label: 'Will not pay' } : { ...entry }
    )));
  });
});
