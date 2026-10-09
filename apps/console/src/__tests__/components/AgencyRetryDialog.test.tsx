import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCampaign, AgencyRetryPreview } from '../../types/agency-campaign';
import type { AgencyRetrySelector } from '../../types/agency-spine';

/**
 * The retry dialog.
 *
 * ── What is worth pinning here ─────────────────────────────────────────────
 * `POST .../retry` creates a campaign and seeds its roster in one transaction,
 * and there is no campaign delete route in either service. So everything below
 * is about what the supervisor is told BEFORE the button, and the two facts
 * that are most often missing when the number looks wrong:
 *
 *  - **`excluded`.** DNC and unusable numbers are removed from the seed
 *    unconditionally, so a supervisor selecting "everything suppressed" gets 40
 *    where they expected 300. Without the note that reads as a bug.
 *  - **The parent still running.** One account runs one campaign at a time by
 *    unique index, so the child is created but cannot be started. Told here it
 *    costs a sentence; discovered at Start it costs a refusal on a campaign
 *    they already made.
 */

const mocks = vi.hoisted(() => ({
  retryPreview: vi.fn(),
  createRetry: vi.fn(),
  useTenant: vi.fn(),
  usePhoneNumbers: vi.fn(),
}));

vi.mock('../../api/agencyCampaigns', () => ({
  retryPreview: mocks.retryPreview,
  createRetry: mocks.createRetry,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
// The caller-ID override renders `CallerIdPicker`, which reads the account's
// numbers. Mocked at the hook so the dialog's own behaviour is what is under
// test — the picker has its own suite.
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: mocks.usePhoneNumbers }));

import { AgencyRetryDialog } from '../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR } from '../../utils/agencyRetrySelector';
import { ApiError } from '../../api/client';

const PARENT: AgencyCampaign = {
  id: 'camp-parent',
  name: 'Q3 Winback',
  status: 'completed',
  retry_generation: 0,
  caller_ids: ['+911234567890'],
  calling_window_start: '09:00:00',
  calling_window_end: '20:00:00',
  disposition_catalog: [
    { code: 'voicemail', label: 'Voicemail' },
    { code: 'ptp', label: 'PTP' },
  ],
};

/**
 * `DEFAULT_RETRY_SELECTOR` — deliberately the real default rather than a
 * hand-written pair.
 *
 * ⚠️ This used to be `{last_outcome: ['no_answer','busy'], never_attempted:
 * true}`, which is the encoding the default was rewritten to STOP using: two
 * dimensions, ANDed by the server, and a contact with no attempts has a NULL outcome
 * — so it matches zero rows on every campaign. The suite stayed green because
 * the dialog forwards whatever it is handed, but anything copied out of here
 * reintroduced the dead default.
 */
const SELECTOR: AgencyRetrySelector = DEFAULT_RETRY_SELECTOR;

function preview(over: Partial<AgencyRetryPreview> = {}): AgencyRetryPreview {
  return {
    matched: 812,
    // `__none__` is present on purpose: it is the server's bucket key for a NULL
    // outcome, a member of the default selector, and therefore in the breakdown
    // of essentially every Retry opened from the campaign header. Without it in
    // the fixture, the breakdown test cannot assert that the raw key never
    // reaches a supervisor — which it already does for `by_last_disposition`.
    by_last_outcome: { no_answer: 500, busy: 112, connected: 100, __none__: 100 },
    by_last_disposition: { voicemail: 180, ptp: 20, __none__: 612 },
    excluded: { dnc: 14, invalid: 3 },
    parent_contacts_total: 4000,
    retry_generation: 0,
    max_seed_rows: 100_000,
    ...over,
  };
}

function renderDialog(
  over: {
    campaign?: Partial<AgencyCampaign>;
    selector?: AgencyRetrySelector;
    dropped?: ('phone' | 'from' | 'to')[];
    droppedValues?: string[];
    origin?: 'filters' | 'campaign';
  } = {},
) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <AgencyRetryDialog
        open
        campaign={{ ...PARENT, ...over.campaign }}
        selector={over.selector ?? SELECTOR}
        droppedFilters={over.dropped ?? []}
        droppedValues={over.droppedValues ?? []}
        origin={over.origin ?? 'filters'}
        onClose={onClose}
        onCreated={onCreated}
      />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

/**
 * The `E`,`E` confirm gesture, as one awaited step.
 *
 * ── Why the second press must be AWAITED, not queried synchronously ─────────
 * `HoldToConfirmButton` arms from a NATIVE keydown listener it attaches in an
 * effect, so the first press reaches React from outside its own event system and
 * "Press E again to create" appears on a later render. A synchronous `getByText`
 * for that label is therefore a query for a render that has usually — but not
 * always — already happened: measured at **one failure in 25 runs of this file
 * alone**, landing on a different test each time, because all six cases share
 * the gesture. The symptom is the label simply not being present, which reads as
 * the button being broken rather than as the test being early.
 *
 * `findByText` waits for it. It is not a sleep and it does not paper over a slow
 * component: it resolves on the same tick in the ordinary case, and the whole
 * gesture stays well inside `DOUBLE_KEY_MS`, so nothing here can outlast the
 * arming window it is driving.
 *
 * ⚠️ Do not "tidy" this back into two `fireEvent` lines, and do not reach for
 * fake timers instead — Testing Library does not advance vitest's, so `findBy*`
 * in this file simply times out under them (tried, and every test in the file
 * failed). An intermittent red is worse than a missing test: it teaches the next
 * reader to press re-run.
 */
async function confirmCreate() {
  // Step 0a — wait for the IDLE label, do not query it synchronously. On a
  // SECOND call (the idempotency-key cases press again after a refusal) the only
  // thing awaited beforehand is that `createRetry` was CALLED, which happens
  // while the button is still `ending` → "Creating…". The rejection returns it
  // to `failed`, whose label is "Create retry campaign" again, one render later.
  // A synchronous `getByText` is therefore a query for a render that has usually
  // — but not always — already happened, and it throws outright rather than
  // retrying. It won every local run and lost on a loaded CI shard; reproduced
  // deterministically by delaying the mocked rejection by 30ms.
  //
  // Exactly the failure this helper's docstring describes for the ARMED label,
  // on the line that fetches the button in the first place.
  const button = (await screen.findByText('Create retry campaign')).closest('button')!;
  // Step 0b — wait until the button can be armed AT ALL. `HoldToConfirmButton`
  // attaches its keydown listener in a passive effect gated on `enabled`, and
  // this dialog's `enabled` is false until the preview resolves. A press before
  // that is not merely early, it is DELIVERED TO NOTHING — no listener, no
  // state change, and no later render that awaiting the armed label could catch.
  // `aria-disabled` is the observable form of that gate (`inert = !enabled ||
  // ending`), and it is why the fix is a wait for the gate rather than a retry
  // of the press: re-pressing risks a second press landing INSIDE
  // `DOUBLE_KEY_MS` of one that did arm, which fires the create rather than
  // arming it.
  await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
  fireEvent.keyDown(button, { key: 'e' });
  const again = await screen.findByText('Press E again to create');
  fireEvent.keyDown(again.closest('button')!, { key: 'e' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
  });
  mocks.usePhoneNumbers.mockReturnValue({
    phoneNumbers: [
      {
        id: 'assignment-1',
        phone_number: '+911234567890',
        phone_number_id: 'phone-1',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        label: 'Main',
        is_default: true,
        max_concurrent_calls: 5,
        capabilities: ['outbound'],
        region: 'IN',
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+911234567890',
  });
  mocks.retryPreview.mockResolvedValue(preview());
});

afterEach(cleanup);

describe('the preview', () => {
  it('previews the selector it was given, against the parent', async () => {
    renderDialog();
    await waitFor(() =>
      expect(mocks.retryPreview).toHaveBeenCalledWith(
        'camp-parent',
        SELECTOR,
        'tenant-1',
        'account-1',
      ),
    );
  });

  it('shows the matched count against the parent’s whole roster', async () => {
    renderDialog();
    const matched = await screen.findByTestId('retry-matched');
    expect(matched.textContent).toContain('812');
    // "812" alone means nothing; "812 of 4,000" is the number a supervisor can
    // check against the campaign they are looking at.
    expect(matched.textContent).toContain('4,000');
  });

  it('breaks the cohort down by outcome and by disposition', async () => {
    renderDialog();
    const byOutcome = await screen.findByTestId('retry-by-outcome');
    expect(byOutcome.textContent).toContain('No answer');
    expect(byOutcome.textContent).toContain('500');

    const byDisposition = screen.getByTestId('retry-by-disposition');
    // The catalog's own label, never the code.
    expect(byDisposition.textContent).toContain('Voicemail');
    // `__none__` is the server's bucket key for a contact nobody wrote up. It is a
    // key, not a code, and must never render as one.
    expect(byDisposition.textContent).toContain('Never written up');
    expect(byDisposition.textContent).not.toContain('__none__');
  });
});

describe('the DNC and invalid exclusion', () => {
  it('accounts for every row the rule removed', async () => {
    renderDialog();
    const note = await screen.findByTestId('retry-excluded');
    expect(note.textContent).toContain('17'); // 14 + 3
    expect(note.textContent).toContain('14');
    expect(note.textContent).toContain('Do Not Call');
    expect(note.textContent).toContain('3');
    expect(note.textContent).toMatch(/not a dialable number/i);
  });

  it('says nothing when nothing was excluded', async () => {
    mocks.retryPreview.mockResolvedValue(preview({ excluded: { dnc: 0, invalid: 0 } }));
    renderDialog();
    await screen.findByTestId('retry-matched');
    expect(screen.queryByTestId('retry-excluded')).toBeNull();
  });

  it('reports only the rule that actually removed rows', async () => {
    mocks.retryPreview.mockResolvedValue(preview({ excluded: { dnc: 9, invalid: 0 } }));
    renderDialog();
    const note = await screen.findByTestId('retry-excluded');
    expect(note.textContent).toContain('Do Not Call');
    expect(note.textContent).not.toMatch(/not a dialable number/i);
  });
});

describe('a parent that is still running', () => {
  it('says up front that the child cannot be started yet', async () => {
    renderDialog({ campaign: { status: 'running' } });
    const note = await screen.findByTestId('retry-parent-running');
    expect(note.textContent).toMatch(/cannot be started/i);
    expect(note.textContent).toMatch(/paused or stopped/i);
    // Creation is still offered — the child is a draft, and only Start is
    // blocked.
    expect(screen.getByText('Create retry campaign')).toBeTruthy();
  });

  it('says nothing on a finished parent', async () => {
    renderDialog();
    await screen.findByTestId('retry-matched');
    expect(screen.queryByTestId('retry-parent-running')).toBeNull();
  });
});

describe('the filters that were left behind', () => {
  it('names them rather than silently narrowing or widening', async () => {
    renderDialog({ dropped: ['phone', 'to'] });
    const note = await screen.findByTestId('retry-dropped-filters');
    expect(note.textContent).toContain('phone-number search');
    expect(note.textContent).toContain('“to” date');
  });

  it('says nothing when nothing was dropped', async () => {
    renderDialog();
    await screen.findByTestId('retry-matched');
    expect(screen.queryByTestId('retry-dropped-filters')).toBeNull();
  });
});

describe('the name and the overrides', () => {
  it('offers the server’s own default name, editable', async () => {
    renderDialog();
    const input = (await screen.findByLabelText('Campaign name')) as HTMLInputElement;
    expect(input.value).toBe('Q3 Winback — Retry 1');
  });

  it('sends no config_overrides when nothing was touched', async () => {
    // The child inherits the parent's whole config server-side. Echoing an
    // untouched value back would turn an inheritance into an explicit write.
    mocks.createRetry.mockResolvedValue({
      campaign: { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft' },
      contacts_seeded: 812,
      excluded: { dnc: 14, invalid: 3 },
    });
    renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    const body = mocks.createRetry.mock.calls[0]![1];
    expect(body.selector).toEqual(SELECTOR);
    expect(body.name).toBe('Q3 Winback — Retry 1');
    expect(body).not.toHaveProperty('config_overrides');
  });

  it('sends a changed calling window as an override', async () => {
    mocks.createRetry.mockResolvedValue({
      campaign: { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft' },
      contacts_seeded: 812,
      excluded: { dnc: 0, invalid: 0 },
    });
    renderDialog();
    await screen.findByTestId('retry-matched');

    fireEvent.change(screen.getByLabelText('Calling starts'), { target: { value: '10:30' } });
    await confirmCreate();

    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    const body = mocks.createRetry.mock.calls[0]![1];
    expect(body.config_overrides).toEqual({ calling_window_start: '10:30' });
    // The untouched end is still the parent's, and is not echoed back.
    expect(body.config_overrides).not.toHaveProperty('calling_window_end');
  });
});

describe('the three refusals', () => {
  it('explains an empty selection and says nothing was created', async () => {
    mocks.createRetry.mockRejectedValue(
      new ApiError(409, { error: 'Conflict', code: 'retry_selection_empty', message: 'no rows' }),
    );
    renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    const error = await screen.findByTestId('retry-submit-error');
    expect(error.textContent).toMatch(/no campaign was created/i);
    expect(error.textContent).toContain('Do Not Call');
    // The server's own sentence is not what a supervisor acts on here.
    expect(error.textContent).not.toContain('no rows');
  });

  it('names the count and the cap when the selection is too large', async () => {
    mocks.createRetry.mockRejectedValue(
      new ApiError(409, { code: 'retry_selection_too_large', message: 'too many' }),
    );
    renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    const error = await screen.findByTestId('retry-submit-error');
    expect(error.textContent).toContain('100,000');
  });

  it('re-arms the button so the supervisor can try a different selection', async () => {
    mocks.createRetry.mockRejectedValue(
      new ApiError(409, { code: 'retry_generation_exceeded', message: 'too deep' }),
    );
    renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    await screen.findByTestId('retry-submit-error');
    // Without the re-arm the button sits at "Creating…" forever, over a
    // campaign that does not exist — there is no timeout on this variant.
    await waitFor(() => expect(screen.getByText('Create retry campaign')).toBeTruthy());
  });
});

describe('nothing to create', () => {
  it('refuses the gesture and says why when the count is zero', async () => {
    mocks.retryPreview.mockResolvedValue(preview({ matched: 0 }));
    renderDialog();
    await screen.findByTestId('retry-empty');
    expect(screen.getByText('Nothing matches this selection.')).toBeTruthy();
    fireEvent.keyDown(screen.getByText('Create retry campaign').closest('button')!, { key: 'e' });
    // `aria-disabled`, never `disabled` — the gesture is inert and the button
    // keeps its place in the tab order.
    expect(screen.queryByText('Press E again to create')).toBeNull();
  });

  it('refuses a selector naming no dimension without asking the server', async () => {
    renderDialog({ selector: {} });
    const error = await screen.findByTestId('retry-preview-error');
    expect(error.textContent).toMatch(/at least one/i);
    expect(mocks.retryPreview).not.toHaveBeenCalled();
  });
});

describe('where it was opened from', () => {
  it('says the cohort is a default when it came from the campaign header', async () => {
    renderDialog({ origin: 'campaign' });
    await screen.findByTestId('retry-matched');
    expect(screen.getByText(/This is the default selection/)).toBeTruthy();
  });

  it('claims nothing about a default when it came from a filtered list', async () => {
    renderDialog({ origin: 'filters' });
    await screen.findByTestId('retry-matched');
    expect(screen.queryByText(/This is the default selection/)).toBeNull();
  });
});

describe('the created campaign', () => {
  it('hands the child back to the caller', async () => {
    const child = { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft' };
    mocks.createRetry.mockResolvedValue({
      campaign: child,
      contacts_seeded: 812,
      excluded: { dnc: 14, invalid: 3 },
    });
    const { onCreated } = renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ campaign: child, contacts_seeded: 812 }),
      ),
    );
  });
});

describe('the idempotency key — at-most-once, minted per OPENING', () => {
  const CHILD = { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft' };

  function key(callIndex = 0): string | undefined {
    const body = mocks.createRetry.mock.calls[callIndex]![1] as { idempotency_key?: string };
    return body.idempotency_key;
  }

  beforeEach(() => {
    mocks.createRetry.mockResolvedValue({
      campaign: CHILD, contacts_seeded: 812, excluded: { dnc: 14, invalid: 3 },
    });
  });

  it('sends one', async () => {
    renderDialog();
    await screen.findByTestId('retry-matched');
    await confirmCreate();

    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    // Shape, not value: the server enforces 16..64 of a bounded alphabet, and a key
    // that fails it is a 400 on the one request that must not be retried blind.
    expect(key()).toMatch(/^[A-Za-z0-9_.:-]{16,64}$/);
  });

  it('REUSES the key when the supervisor presses again after a refusal', async () => {
    /**
     * The case the whole field exists for, and the one a per-request key gets
     * wrong. A refusal and a lost success are indistinguishable from the
     * browser — so pressing again must either create (the server rolls a refusal back
     * before writing the key) or REPLAY the campaign that was really made. A
     * fresh key on the second press can only do the first, which on a lost
     * success is a second campaign over the same cohort.
     */
    mocks.createRetry.mockRejectedValueOnce(
      new ApiError(409, { code: 'retry_selection_empty', message: 'no rows' }),
    );
    renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalledTimes(1));
    // The button re-arms itself after a refusal, which is what makes a second
    // press reachable at all.
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalledTimes(2));

    expect(key(1)).toBe(key(0));
  });

  it('mints a FRESH key when the dialog is CLOSED and reopened in place', async () => {
    /**
     * Reopening is a new intent. Carrying the previous key over would replay the
     * campaign it already created and create nothing — the failure the key
     * exists to prevent, inverted, and just as invisible: a success toast over a
     * campaign authored minutes ago against a different cohort.
     *
     * Driven by toggling `open` on ONE MOUNTED INSTANCE rather than by
     * unmounting and rendering again. Both call sites happen to render the
     * dialog conditionally today, so a remount would pass on a key minted once
     * per mount and prove nothing about the effect that actually owns this —
     * measured: a mutation that mints only on the first opening survives the
     * remount spelling of this test and is caught by this one.
     */
    const { rerender } = render(
      <MemoryRouter>
        <AgencyRetryDialog
          open
          campaign={PARENT}
          selector={SELECTOR}
          droppedFilters={[]}
          origin="filters"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    const dialog = (open: boolean) => (
      <MemoryRouter>
        <AgencyRetryDialog
          open={open}
          campaign={PARENT}
          selector={SELECTOR}
          droppedFilters={[]}
          origin="filters"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </MemoryRouter>
    );

    await screen.findByTestId('retry-matched');
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalledTimes(1));

    rerender(dialog(false));
    rerender(dialog(true));

    await screen.findByTestId('retry-matched');
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalledTimes(2));

    expect(key(1)).not.toBe(key(0));
  });

  it('hands a REPLAY back as an ordinary success', async () => {
    // The server answers 200 + `idempotent_replay: true`; the campaign is the one this
    // supervisor already made, and the console's job is to take them to it. A
    // dialog that treated it as an error would leave them believing nothing
    // exists, over a campaign that does.
    mocks.createRetry.mockResolvedValue({
      campaign: CHILD, idempotent_replay: true, contacts_seeded: null, excluded: null,
    });
    const { onCreated } = renderDialog();
    await screen.findByTestId('retry-matched');

    await confirmCreate();

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ campaign: CHILD, idempotent_replay: true }),
      ),
    );
    expect(screen.queryByTestId('retry-submit-error')).toBeNull();
  });
});

describe('the outcome breakdown never shows a raw bucket key', () => {
  it('renders __none__ as words, the way the disposition breakdown already does', async () => {
    // `attemptOutcomeLabel` falls through to the raw string for anything it does
    // not know, so this rendered literally `__none__` on screen. Not a rare
    // shape: it is the server's `by_last_outcome` key for a NULL outcome, a member of
    // `DEFAULT_RETRY_SELECTOR`, and therefore in the breakdown of essentially
    // every Retry opened from the campaign header.
    renderDialog();
    const block = await screen.findByTestId('retry-by-outcome');
    expect(block.textContent).not.toContain('__none__');
    expect(block.textContent).toContain('Never dialed');
  });

  it('still shows the raw key nowhere else in the dialog', async () => {
    renderDialog();
    await screen.findByTestId('retry-by-outcome');
    expect(document.body.textContent).not.toContain('__none__');
  });
});

describe('filter values that can never be retried are named, not silently sent', () => {
  it('tells the supervisor that DNC contacts were left behind', async () => {
    // The roster offers `dnc` as a chip — arguably the reason that tab exists —
    // and the server answers a 400 on the whole request for it. Without this the
    // supervisor lands on a refused preview about a field they did type.
    renderDialog({ droppedValues: ['dnc'] });
    const note = await screen.findByTestId('retry-refused-values');
    expect(note.textContent).toContain('Do Not Call');
  });

  it('names contacts currently on a call as their own reason', async () => {
    renderDialog({ droppedValues: ['in_flight'] });
    const note = await screen.findByTestId('retry-refused-values');
    expect(note.textContent).toContain('currently on a call');
  });

  it('says nothing when nothing was refused', () => {
    renderDialog();
    expect(screen.queryByTestId('retry-refused-values')).toBeNull();
  });
});

describe('the caller-ID picker cannot be emptied into a silent inheritance', () => {
  it('blocks confirmation with a reason when every ID is deselected', async () => {
    // An empty `caller_ids` is omitted from the overrides, so sending anyway
    // would make the child inherit the PARENT's IDs while the picker shows none
    // selected — a campaign dialling from numbers the supervisor just removed,
    // with nothing on screen saying so.
    renderDialog({ campaign: { caller_ids: ['+911234567890'] } });
    await screen.findByTestId('retry-by-outcome');

    // Through the picker's own checkbox, not by seeding an empty campaign —
    // deselection is the path that reaches this, and a parent with no caller
    // IDs is not a state the product can be in.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const checked = boxes.find((box) => box.checked)!;
    expect(checked).toBeTruthy();
    fireEvent.click(checked);

    await waitFor(() => {
      const button = screen.getByText('Create retry campaign').closest('button')!;
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    expect(document.body.textContent).toContain('Choose at least one caller ID');
  });
});
