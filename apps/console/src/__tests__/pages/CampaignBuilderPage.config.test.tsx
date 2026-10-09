import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The same behaviour at the PAGE level — the config sections as an operator meets
 * them, not as isolated components.
 *
 * (a) built-in codes cannot be deleted in the UI and the reason is explained
 * inline; (b) server validation errors map to the offending field.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
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
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

async function renderPage() {
  const { default: CampaignBuilderPage } = await import(
    '../../pages/campaigns/agency/CampaignBuilderPage'
  );
  return render(
    <MemoryRouter>
      <CampaignBuilderPage />
    </MemoryRouter>,
  );
}

/**
 * Name + caller ID, the two things the API requires before a campaign can exist.
 * `Save campaign` creates it on first use, so the config tests have to satisfy
 * both before they can assert anything about the config payload.
 */
function fillRequiredBasics() {
  fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
}

function goToStep(title: string) {
  fireEvent.click(screen.getByRole('button', { name: title }));
}

async function openBehaviour() {
  await renderPage();
  fillRequiredBasics();
  goToStep('How agents work');
}

async function openHours() {
  await renderPage();
  fillRequiredBasics();
  goToStep('When to call');
}

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the disposition catalog editor', () => {
  it('renders the three built-ins with Remove disabled and the reason beside it', async () => {
    await openBehaviour();

    for (const code of ['voicemail', 'callback', 'do_not_call']) {
      expect(screen.getByTestId(`lock-${code}`)).toBeTruthy();
    }
    // (a): not merely disabled — a lock with no reason reads as a permissions bug.
    expect(screen.getByTestId('lock-callback').textContent).toContain('schedule a call for later');
    expect((screen.getByRole('button', { name: 'Remove Callback' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('reorders outcomes, because the order is the agent’s number key', async () => {
    // The hint has always said the order is the number key an agent presses.
    // Until now the only way to change it was to delete an entry and retype
    // it — and a built-in cannot be deleted at all, so the first three keys
    // were fixed for good.
    await openBehaviour();
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Voicemail');

    fireEvent.click(screen.getByRole('button', { name: 'Move Callback up' }));

    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Callback');
    expect((screen.getByLabelText('Outcome 2 label') as HTMLInputElement).value).toBe('Voicemail');
    // The ends stay put rather than wrapping round.
    expect((screen.getByRole('button', { name: 'Move Callback up' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('fills the code in from the label until the operator writes one', async () => {
    await openBehaviour();
    fireEvent.click(screen.getByRole('button', { name: 'Add an outcome' }));

    fireEvent.change(screen.getByLabelText('Outcome 4 label'), {
      target: { value: 'Promised to pay' },
    });
    expect((screen.getByLabelText('Outcome 4 code') as HTMLInputElement).value)
      .toBe('promised_to_pay');

    // A hand-typed code detaches permanently — renaming must not overwrite it.
    fireEvent.change(screen.getByLabelText('Outcome 4 code'), { target: { value: 'ptp' } });
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), {
      target: { value: 'Promised to pay soon' },
    });
    expect((screen.getByLabelText('Outcome 4 code') as HTMLInputElement).value).toBe('ptp');
  });

  /**
   * The regression this pins is invisible to a one-shot `fireEvent.change` with
   * the finished string, which is what the test above does and why it passed
   * over a card that could not actually be typed into.
   *
   * The list key used to embed `entry.code`. Because a new outcome's code
   * follows its label, every keystroke changed the key, React unmounted the
   * card and mounted a fresh one, and the field being typed into was destroyed
   * along with the caret — one character per click into the box.
   */
  it('survives being typed into one character at a time, caret and all', async () => {
    await openBehaviour();
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
    await openBehaviour();
    // The built-ins are still identifiable by code…
    expect(screen.getByTestId('lock-callback').textContent).toContain('schedule a call for later');
    // …but the fixed value is not offered as an editable-looking field.
    expect(screen.queryByLabelText('Outcome 2 code')).toBeNull();
  });

  it('says what the combination of flags actually does, not just which are on', async () => {
    await openBehaviour();
    // Voicemail: the default entry's own retry rule, which no control used to
    // show and nothing on screen used to state.
    expect(screen.getByTestId('outcome-summary-0').textContent)
      .toContain('every 4 hours, up to 2 times');
    expect(screen.getByTestId('outcome-summary-2').textContent).toContain('suppressed');

    // "Ends this contact" and "Stops calling this contact" are different
    // things, and the summary is where the difference is stated.
    const sale = screen.getByTestId('outcome-summary-1');
    expect(sale.textContent).toContain('pick a date and time to call back');
  });

  it('warns when Ends is set beside Stops, which the API never reaches', async () => {
    await openBehaviour();
    expect(screen.queryByTestId('precedence-2')).toBeNull();

    // `do_not_call` already carries `suppress`; adding `terminal` is legal and
    // saves, and is also unreachable — the API returns on the suppress arm.
    const dncFlags = screen.getByRole('group', {
      name: 'What happens when an agent files Do not call',
    });
    fireEvent.click(within(dncFlags).getByRole('checkbox', { name: /Ends this contact/ }));

    expect(screen.getByTestId('precedence-2').textContent).toContain('adds nothing');
  });

  it('offers the disposition’s own retry, and withdraws it where the API cannot read it', async () => {
    // The retry table says in so many words that voicemail retry lives on the
    // voicemail disposition. There was no control for it.
    await openBehaviour();
    const voicemailFlags = screen.getByRole('group', {
      name: 'What happens when an agent files Voicemail',
    });
    const voicemail = within(voicemailFlags.closest('li')!);
    expect(
      (voicemail.getByRole('checkbox', {
        name: /Call this contact again after this outcome/,
      }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Voicemail retry attempts'), { target: { value: '4' } });
    expect(screen.getByTestId('outcome-summary-0').textContent).toContain('up to 4 times');

    // Ending the contact makes the rule unreachable, so the control goes and
    // the reason takes its place rather than a dead input staying on screen.
    fireEvent.click(within(voicemailFlags).getByRole('checkbox', { name: /Ends this contact/ }));
    expect(screen.queryByLabelText('Voicemail retry attempts')).toBeNull();
    expect(screen.getByTestId('retry-inert-0').textContent).toContain('nothing will act on it');
  });

  it('lets an operator add and remove a custom outcome', async () => {
    await openBehaviour();
    fireEvent.click(screen.getByRole('button', { name: 'Add an outcome' }));

    const codeField = screen.getByLabelText('Outcome 4 code');
    fireEvent.change(codeField, { target: { value: 'promised_to_pay' } });
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay' } });

    const remove = screen.getByRole('button', { name: 'Remove Promised to pay' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(screen.queryByLabelText('Outcome 4 code')).toBeNull();
  });
});

describe('wrap-up', () => {
  /**
   * `wrapup_auto_return` decides whether an agent's shift is paced by a timer or
   * by them: on, the countdown returns them to the pool; off, they sit in
   * wrap-up until they say they are ready. The API has stored and read it
   * all along; the form hardcoded it and never sent it.
   */
  it('offers the control and sends it on save', async () => {
    await openBehaviour();
    const box = screen.getByRole('checkbox', {
      name: /send agents back to the pool automatically/i,
    }) as HTMLInputElement;
    // The API's own column default, so a new campaign starts where it always did.
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].wrapup_auto_return).toBe(false);
  });

  it('says what each setting means for an agent, not just that it is on', async () => {
    await openBehaviour();
    // A checkbox labelled "auto return" with no consequence stated is a setting
    // nobody can choose between.
    expect(screen.getByTestId('auto-return-hint').textContent).toContain('on their own');

    fireEvent.click(
      screen.getByRole('checkbox', { name: /send agents back to the pool automatically/i }),
    );
    expect(screen.getByTestId('auto-return-hint').textContent).toContain('mark themselves ready');
  });

  it('says the flag is inert with no wrap-up window, rather than greying it out', async () => {
    // The API only starts a countdown when there is BOTH a window and the flag, so
    // at 0 the checkbox is stored but does nothing. Disabling it would discard
    // the operator's choice the moment they set the window back.
    await openBehaviour();
    fireEvent.change(screen.getByLabelText(/Wrap-up seconds/), { target: { value: '0' } });

    expect(screen.getByTestId('auto-return-hint').textContent).toContain('no countdown');
    expect(
      (screen.getByRole('checkbox', {
        name: /send agents back to the pool automatically/i,
      }) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});

describe('the retry policy editor', () => {
  it('shows invalid and connected as fixed at zero WITH the reason, not hidden', async () => {
    await openBehaviour();
    // Hiding them invites the operator to assume they retry.
    expect(screen.getByTestId('fixed-invalid').textContent).toContain('does not become valid');
    expect(screen.getByTestId('fixed-connected').textContent).toContain('agent');
    expect(screen.queryByLabelText('Invalid number max attempts')).toBeNull();
  });

  it('previews a configured rule in English', async () => {
    await openBehaviour();
    fireEvent.change(screen.getByLabelText('Busy delay in minutes'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Busy max attempts'), { target: { value: '4' } });

    expect(screen.getByTestId('retry-previews').textContent).toContain(
      'Busy: retried every 15 minutes, up to 4 times.',
    );
  });

  it('explains that voicemail retry lives on the disposition, not here', async () => {
    await openBehaviour();
    expect(screen.getByTestId('voicemail-retry-callout').textContent).toContain('voicemail disposition');
  });

  /**
   * The API added `agent_disconnected` to its validator and
   * reads it on the dial path, but this wizard never followed — an operator
   * could only set the cap by curl.
   */
  it('offers an editable `agent_disconnected` row, labelled as our fault', async () => {
    await openBehaviour();

    // Editable, not fixed-at-zero: The API genuinely honours a configured cap,
    // unlike `invalid`/`connected`.
    expect(screen.getByLabelText('Agent disconnected (our fault) max attempts')).toBeTruthy();
    expect(screen.queryByTestId('fixed-agent_disconnected')).toBeNull();
  });

  it('does NOT offer an `orphaned` row — the API never reads a campaign value for it', () => {
    // A control that saves, persists and reloads while changing nothing is worse
    // than no control: it tells the operator they have tuned something.
    return openBehaviour().then(() => {
      expect(screen.queryByLabelText('Orphaned by a restart (our fault) max attempts')).toBeNull();
    });
  });

  it('does not zero the platform bound when only the DELAY is typed', async () => {
    /*
     * The regression this exists for. The row seed was `{ max_attempts: 0 }`, so
     * touching only the delay box submitted `max_attempts: 0` the operator never
     * typed — and the API reads `min(configured, OUR_FAULT_REDIAL_BOUND)`, retiring
     * the contact on its FIRST pre-connect agent drop. Never dialed again.
     */
    await openBehaviour();
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) delay in minutes'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const sent = mocks.updateAgencyCampaign.mock.calls[0]![1].retry_policy.agent_disconnected;
    expect(sent.delay_minutes).toBe(7);
    expect(sent.max_attempts).toBe(3);
  });

  it('warns on the row when the operator really does set 0', async () => {
    // 0 is a legitimate choice, so this is a consequence rather than an error —
    // but "0 attempts" does not convey "retire the contact outright".
    await openBehaviour();
    expect(screen.queryByTestId('our-fault-zero-agent_disconnected')).toBeNull();
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) max attempts'), {
      target: { value: '0' },
    });
    expect(screen.getByTestId('our-fault-zero-agent_disconnected').textContent)
      .toMatch(/retires the contact permanently/);
  });

  it('sends a configured `agent_disconnected` cap on save', async () => {
    await openBehaviour();

    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) delay in minutes'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) max attempts'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].retry_policy.agent_disconnected).toEqual({
      delay_minutes: 5,
      max_attempts: 3,
    });
  });

  it('says the bound can be lowered here, and what lowering it to 0 costs', async () => {
    /*
     * The earlier copy said the platform limit "cannot be raised from here" and
     * called it "smaller" — the first is only half true and the second is false
     * (both are 3). Together they read as "this row cannot affect the bound",
     * which is exactly the belief that makes setting it to 0 look harmless.
     */
    await openBehaviour();
    const callout = screen.getByTestId('our-fault-retry-callout').textContent!;
    expect(callout).toContain('Our fault');
    expect(callout).toMatch(/only LOWER it here, never raise it/);
    expect(callout).toMatch(/retires that contact for good/);
    expect(callout.toLowerCase()).not.toContain('smaller');
  });

  /**
   * Since the 2026-09-08 pilot, a dial we stopped before anyone picked up is its
   * own outcome, is charged to the our-fault ledger, and the API accepts the
   * retry-policy key — so the wizard has to offer the row, or the lever is
   * curl-only again.
   */
  it('offers an editable `canceled` row, labelled as our fault', async () => {
    await openBehaviour();

    expect(screen.getByLabelText('Stopped by us before answer (our fault) max attempts')).toBeTruthy();
    expect(screen.queryByTestId('fixed-canceled')).toBeNull();
  });

  it('does not zero the bound when only the DELAY is typed on the `canceled` row', async () => {
    // The `agent_disconnected` regression, one row down. The seed comes from
    // `OUR_FAULT_RETRY_OUTCOMES` membership, so a row that is our-fault in the API
    // and not named in that list would send a `max_attempts: 0` nobody typed —
    // retiring the contact on its first cancelled dial.
    await openBehaviour();
    fireEvent.change(screen.getByLabelText('Stopped by us before answer (our fault) delay in minutes'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const sent = mocks.updateAgencyCampaign.mock.calls[0]![1].retry_policy.canceled;
    expect(sent.delay_minutes).toBe(10);
    expect(sent.max_attempts).toBe(3);
  });

  it('warns on the `canceled` row when the operator really does set 0', async () => {
    await openBehaviour();
    expect(screen.queryByTestId('our-fault-zero-canceled')).toBeNull();
    fireEvent.change(screen.getByLabelText('Stopped by us before answer (our fault) max attempts'), {
      target: { value: '0' },
    });
    expect(screen.getByTestId('our-fault-zero-canceled').textContent)
      .toMatch(/retires the contact permanently/);
  });

  it('names BOTH our-fault failures in the one shared callout', async () => {
    // One callout under one table. It used to name only an agent-side drop,
    // which left the `canceled` row's rule unstated on the screen that sets it.
    await openBehaviour();
    const callout = screen.getByTestId('our-fault-retry-callout').textContent!;
    expect(callout).toContain('agent-side drop');
    expect(callout).toContain('before anyone picked up');
  });
});

describe('calling hours', () => {
  it('echoes the window in plain English', async () => {
    await openHours();
    const echo = screen.getByTestId('calling-window-echo').textContent!;
    expect(echo).toContain('Mon–Fri');
    expect(echo).toContain('09:00–20:00');
    expect(echo).toContain('Asia/Kolkata');
  });

  it('re-echoes an inverted window as the operator types it', async () => {
    // The echo exists because a pair of time inputs cannot show an inverted
    // range. It has to be live, or it only catches the mistake on save.
    await openHours();
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '06:00' } });
    expect(screen.getByTestId('calling-window-echo').textContent).toContain('overnight');
  });

  it('displays the concurrency limit without offering a control', async () => {
    await openHours();
    const note = screen.getByTestId('concurrency-note');
    expect(note.textContent).toContain('shared with your AI calls');
    expect(note.textContent).toContain('Contact support');
    // No input, no stepper, no Edit link — a greyed-out control reads as "you
    // lack permission today" and produces a support ticket with no resolution.
    expect(note.querySelector('input')).toBeNull();
    expect(note.querySelector('button')).toBeNull();
    expect(note.querySelector('a')).toBeNull();
  });
});

describe('validation', () => {
  it('blocks the save on a client-side finding and says why', async () => {
    await openHours();
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } });

    expect(screen.getByTestId('config-block')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save campaign' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('lands a SERVER validation error on the offending field, not in a banner', async () => {
    // (b). The API's config validator answers a flat `details` record keyed by
    // the body path; `ApiError` cannot summarise that shape, so its message is
    // the bare 'Validation Error' and the detail is only reachable from
    // `err.details`.
    mocks.updateAgencyCampaign.mockRejectedValue(
      Object.assign(new Error('Validation Error'), {
        statusCode: 400,
        details: {
          error: 'Validation Error',
          details: {
            'default_timezone':
              "default_timezone must be a full IANA zone name like 'America/New_York'.",
          },
        },
      }),
    );

    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
    fillRequiredBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() =>
      expect(screen.getByText(/must be a full IANA zone name/)).toBeTruthy(),
    );
    // Beside the field it is about — the timezone input's own form group.
    const message = screen.getByText(/must be a full IANA zone name/);
    expect(message.closest('.form-group')?.querySelector('#window-timezone')).toBeTruthy();
    expect(screen.queryByTestId('builder-error')).toBeNull();
  });

  it('sends the whole config, including an empty retry policy', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
    fillRequiredBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const [, body] = mocks.updateAgencyCampaign.mock.calls[0]!;
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
   * The campaign table declares no `description` column and its update
   * whitelist does not list it, so the field wrote nothing. The API forwards the
   * body unchanged, which is what made it look like it worked.
   */
  it('offers no Description field', async () => {
    await renderPage();
    expect(screen.queryByLabelText(/description/i)).toBeNull();
  });

  it('sends no `description` key on create', async () => {
    await renderPage();
    fillRequiredBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));

    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    // The whole body, not just the absent key: an empty-but-present field sent
    // `description: null` from the settings page and nothing from here, so
    // asserting absence alone would have passed against the broken version too.
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toEqual({
      name: 'Collections',
      caller_ids: ['+912200000001'],
      telephony_provider: 'voicelink',
    });
  });
});
