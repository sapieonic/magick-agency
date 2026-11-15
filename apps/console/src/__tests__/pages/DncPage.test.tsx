import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { DncAddSummary, DncEntry } from '../../types/dnc';

/**
 * The Do Not Call list.
 *
 * This surface makes a promise about who will not be called, so the failure that
 * matters is not a broken layout — it is a number that **looks** suppressed and
 * is not, or an entry nobody can find in order to correct it. Every case below
 * is one of those.
 *
 * There is a second class of the same
 * failure (decision Q2): a promise that is true but reads wider than it is. DNC is
 * **agency-only** — the API's dial-time gate lives in `agency/pre-dial-gates.ts`
 * and nothing else consults it — so copy presenting the list as
 * compliance for every kind of call leaves an operator believing a customer who asked not
 * to be called is protected on surfaces that never check.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useAuth: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  useTeam: vi.fn(),
  listDncEntries: vi.fn(),
  addDncEntries: vi.fn(),
  removeDncEntry: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  /** The client flags on; the soft phone's, unless a test turns it off. */
  flags: new Set<string>(['agency_softphone_enabled']),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => mocks.flags.has(flag),
}));
vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/dnc', () => ({
  listDncEntries: mocks.listDncEntries,
  addDncEntries: mocks.addDncEntries,
  removeDncEntry: mocks.removeDncEntry,
}));

import DncPage from '../../pages/agency/DncPage';

function entry(over: Partial<DncEntry> = {}): DncEntry {
  return {
    id: 'dnc-1',
    tenant_id: 'tenant-1',
    account_id: null,
    campaign_id: null,
    phone_e164: '+919820041772',
    source: 'agent',
    reason: null,
    added_by: 'user-1',
    created_at: '2026-08-01T10:00:00Z',
    scope: 'tenant',
    scope_account_id: null,
    account_name: null,
    campaign_name: null,
    ...over,
  };
}

/** A member of the whole organisation (`tenant`), or an admin of account-1 only (`account`). */
function memberships(kind: 'tenant' | 'account', role = 'tenant_owner') {
  return [{
    id: 'm1', user_id: 'u1', tenant_id: 'tenant-1', account_id: kind === 'tenant' ? null : 'account-1',
    role, status: 'active',
  }];
}

/** The list calls the page makes for its table: not the removal dialog's look-up by number. */
function tableCalls() {
  return mocks.listDncEntries.mock.calls.filter(([params]) => !params.phone || params.offset !== undefined);
}

function page(entries: DncEntry[], total = entries.length) {
  return { entries, total, limit: 50, offset: 0 };
}

function summary(over: Partial<DncAddSummary> = {}): DncAddSummary {
  return { added: 1, already_present: 0, already_covered: 0, invalid: 0, results: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
    accounts: [{ id: 'account-1', name: 'North' }],
  });
  mocks.useAuth.mockReturnValue({ memberships: memberships('tenant') });
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'camp-1', name: 'Q4 Renewals', status: 'running' },
    { id: 'camp-2', name: 'Q3 Renewals', status: 'completed' },
  ]);
  mocks.useTeam.mockReturnValue({
    members: [
      { membership: {}, user: { id: 'user-1', display_name: 'Priya Menon', email: 'p@x.com' } },
    ],
  });
  mocks.listDncEntries.mockResolvedValue(page([entry()]));
  mocks.addDncEntries.mockResolvedValue(summary());
  mocks.removeDncEntry.mockResolvedValue({ removed: entry() });
});

afterEach(cleanup);

describe('DNC — scope, and what actually suppresses a call', () => {
  /**
   * Three scopes, three genuinely different answers — and the column has to give
   * the right one for each, because both wrong answers are harmful:
   *
   *  * claiming a scoped row stops nothing prints "this does not stop any call"
   *    beside a live suppression (the defect this replaced: campaign-scoped
   *    marks ARE enforced, at that campaign's roster import, and at mark time);
   *  * claiming it stops everything means the operator never adds the
   *    tenant-wide entry the customer actually asked for.
   *
   * Every check (dial time, roster import, the soft phone) reads `dnc_entries` with
   * the same widening predicate (decision B8): a scoped row is enforced exactly for
   * its account or campaign, and nowhere else. That reach is what these pin.
   */
  it('shows a tenant-wide entry as enforced across every agency campaign', async () => {
    render(<DncPage />);

    expect(await screen.findByTestId('dnc-scope-tenant')).toBeTruthy();
    expect(screen.getByTestId('dnc-scope-tenant').textContent).toBe('Every campaign');
    const title = screen.getByTestId('dnc-scope-tenant').getAttribute('title') ?? '';
    // The only scope that may claim the dial-time block list.
    expect(title).toContain('Enforced for all agency dialling');
    // OVER-claim guard, and the widest claim on the page. "Enforced
    // everywhere" is what this said, and everywhere is not what it is: the
    // dial-time set is read by the agency pacing engine alone.
    expect(title).not.toMatch(/enforced everywhere/i);
    expect(title).toContain('does not stop AI calls or broadcasts');
  });

  it('shows a campaign-scoped entry as enforced for one campaign — not as unenforced', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({
      campaign_id: 'camp-9', scope: 'campaign', campaign_name: 'Q4 Renewals', account_name: 'North', scope_account_id: 'account-1',
    })]));

    render(<DncPage />);

    const badge = await screen.findByTestId('dnc-scope-campaign');
    expect(badge.textContent).toBe('Campaign: Q4 Renewals');
    const title = badge.getAttribute('title') ?? '';
    // UNDER-claim guard: it must not say the row does nothing. This is the exact
    // sentence that shipped, beside a suppression that is live.
    expect(title).not.toMatch(/does not stop any call/i);
    expect(title).not.toMatch(/not enforced/i);
    expect(badge.textContent).not.toMatch(/not enforced/i);
    expect(title).toContain('Enforced for one campaign only');
    expect(title).toContain('that campaign won’t dial this number');
    // The soft phone's untagged call honours it too (docs/softphone.md §4.1 step 2).
    expect(title).toContain('not logged to a campaign is stopped too');
    // OVER-claim guard: it must not imply the workspace-wide block.
    expect(title).toMatch(/Every other campaign in this organisation can still call/i);
  });

  it('shows an account-scoped entry as enforced for that account\'s dials and soft phone', async () => {
    // The row a soft-phone Mark DNC writes on a call logged to no campaign.
    mocks.listDncEntries.mockResolvedValue(page([entry({
      account_id: 'account-9', scope: 'account', account_name: 'South', scope_account_id: 'account-9',
    })]));

    render(<DncPage />);

    const badge = await screen.findByTestId('dnc-scope-account');
    expect(badge.textContent).toBe('South account');
    const title = badge.getAttribute('title') ?? '';
    // UNDER-claim guard: the dial-time check reads the account's rows (B8), so it must
    // not say a contact already imported can still be called.
    expect(title).toContain('none of that account’s campaigns will dial this number');
    expect(title).toContain('The soft phone stops a call to it from that account');
    expect(title).not.toMatch(/import only|already imported|block list/i);
    // OVER-claim guard: other accounts are untouched.
    expect(title).toContain('Campaigns in other accounts are unaffected');
    // And it is a DIFFERENT answer from the campaign one, not a shared "narrow"
    // bucket — collapsing the two is how the old boolean got this wrong.
    expect(badge.textContent).not.toMatch(/campaign/i);
  });

  it('shows the scope the server read off the row, and says so when the campaign no longer exists', async () => {
    mocks.listDncEntries.mockResolvedValue(
      page([entry({ account_id: 'account-9', campaign_id: 'camp-9', scope: 'campaign', campaign_name: null })]),
    );

    render(<DncPage />);

    expect((await screen.findByTestId('dnc-scope-campaign')).textContent).toBe('A campaign that no longer exists');
    expect(screen.queryByTestId('dnc-scope-account')).toBeNull();
  });

  it('never tells an operator that a scoped entry stops nothing', async () => {
    // The page-level copy has to agree with the column, or the banner re-states
    // the defect the column just fixed.
    mocks.listDncEntries.mockResolvedValue(page([entry({ campaign_id: 'camp-9', scope: 'campaign' })]));

    render(<DncPage />);
    await screen.findByTestId('dnc-scope-campaign');

    // Positive first, so the negatives below cannot pass vacuously on a guide
    // that simply failed to render.
    expect(document.body.textContent).toMatch(/Choose where each add applies: every campaign, this account’s campaigns, or one campaign/);
    expect(document.body.textContent).not.toMatch(/are NOT enforced/);
    expect(document.body.textContent).not.toMatch(/never dialed by an agency campaign/);
  });

  it('does not filter scoped rows out of the request', async () => {
    render(<DncPage />);

    await waitFor(() => expect(mocks.listDncEntries).toHaveBeenCalled());
    const [params] = mocks.listDncEntries.mock.calls[0]!;
    // Filtering to `account_id: 'tenant'` would hide the rows that look
    // suppressed and are not — the one case an operator most needs to see.
    expect(params.account_id).toBeUndefined();
    expect(params.campaign_id).toBeUndefined();
    expect(params.scope).toBeUndefined();
  });

  it('filters by scope and by campaign, from the first page', async () => {
    render(<DncPage />);
    const filter = await screen.findByLabelText('Show entries for');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Campaign: Q4 Renewals' })).toBeTruthy());

    fireEvent.change(filter, { target: { value: 'tenant' } });
    await waitFor(() => expect(tableCalls().at(-1)![0]).toMatchObject({ scope: 'tenant', offset: 0 }));
    fireEvent.change(filter, { target: { value: 'account' } });
    await waitFor(() => expect(tableCalls().at(-1)![0]).toMatchObject({ scope: 'account', account_id: 'account-1' }));
    fireEvent.change(filter, { target: { value: 'c:camp-1' } });
    await waitFor(() => expect(tableCalls().at(-1)![0]).toMatchObject({ campaign_id: 'camp-1' }));
    expect(screen.getByRole('option', { name: 'North account' })).toBeTruthy();
  });

  it('does not offer the every-campaign filter to an account admin, who cannot list those entries', async () => {
    mocks.useAuth.mockReturnValue({ memberships: memberships('account', 'account_admin') });
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', accounts: [] });

    render(<DncPage />);
    await screen.findByLabelText('Show entries for');
    expect(screen.queryByRole('option', { name: 'Every campaign' })).toBeNull();
    expect(screen.getByRole('option', { name: 'This account' })).toBeTruthy();
  });
});

describe('DNC — agency-only, and the copy has to say so', () => {
  it('says which product this list governs, and which it does not', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');

    // Positive first, so the negative below cannot pass on a guide that simply
    // failed to render.
    expect(document.body.textContent).toMatch(/Agency campaigns don’t dial the numbers on this list/);
    // The sentence a customer needs and the page never had: what this list does
    // NOT cover.
    expect(document.body.textContent).toMatch(/does not apply to AI calls or broadcasts/);
  });

  it('says the soft phone is covered too, with an audited override (SP1)', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');

    // The old copy said DNC did NOT apply to the soft phone; it does now. A soft-phone
    // dial to a listed number is refused, and placing it anyway needs a written
    // reason that is logged with the agent's name.
    expect(document.body.textContent).not.toMatch(/not apply to[^.]*soft ?phone/i);
    expect(document.body.textContent).toMatch(/The soft phone checks it too/);
    // Exactly what the pre-dial reads (docs/softphone.md §4.1 step 2): a tagged call the
    // tag's scopes, an untagged one the account's and every one of its campaigns'.
    expect(document.body.textContent).toMatch(/a call logged to a campaign is stopped by the entries that campaign honours/);
    expect(document.body.textContent).toMatch(/a call logged to no campaign by an entry for the organisation, its account or any of the account’s campaigns/);
    expect(document.body.textContent).toMatch(/writing down why — that reason is logged with their name/);
  });

  /*
   * The header's one line about reach. It said the soft phone "never" calls a listed
   * number, under a description that says an agent may, by writing down why — and
   * "never" is wrong for a scoped entry too, which holds only where its Scope names.
   */
  it('says in the header what the list stops, without "never", for either soft-phone setting', async () => {
    render(<DncPage />);
    const withPhone = await screen.findByText('Numbers agency campaigns don’t dial and the soft phone stops, and who listed them.');
    expect(withPhone.textContent).not.toMatch(/\bnever\b/i);
    cleanup();

    mocks.flags.delete('agency_softphone_enabled');
    try {
      render(<DncPage />);
      const withoutPhone = await screen.findByText('Numbers agency campaigns don’t dial, and who listed them.');
      expect(withoutPhone.textContent).not.toMatch(/\bnever\b|soft phone/i);
    } finally {
      mocks.flags.add('agency_softphone_enabled');
    }
  });

  it('says nothing about the soft phone where it is off (agency_softphone_enabled)', async () => {
    mocks.flags.delete('agency_softphone_enabled');
    try {
      mocks.listDncEntries.mockResolvedValue(page([entry({ account_id: 'account-9', scope: 'account' })]));
      render(<DncPage />);
      const badge = await screen.findByTestId('dnc-scope-account');
      // Positive first, so the negatives cannot pass on a page that failed to render.
      expect(document.body.textContent).toMatch(/Agency campaigns don’t dial the numbers on this list/);
      expect(document.body.textContent).toMatch(/Agents add numbers from the station when a customer asks/);
      expect(document.body.textContent).not.toMatch(/soft phone/i);
      expect(badge.getAttribute('title')).toContain('none of that account’s campaigns will dial this number');
      expect(badge.getAttribute('title')).not.toMatch(/soft phone/i);
    } finally {
      mocks.flags.add('agency_softphone_enabled');
    }
  });

  it('never presents itself as platform-wide regulatory compliance', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');

    // "treat removals as a compliance decision" was the page's own framing, on
    // a list that binds one product. The removal tip still says removals matter
    // — it just says it in terms of the customer's request, which is true.
    expect(document.body.textContent).not.toMatch(/compliance/i);
    expect(document.body.textContent).toMatch(/if the customer asked not to be called/);
  });

  it('narrows the regulator source so it cannot be read as a platform-wide record', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({ source: 'regulator' })]));

    render(<DncPage />);

    // The STORED value is untouched — the API still writes and filters
    // `source: 'regulator'`; only the words it renders as are narrowed.
    const cell = await screen.findByText('Regulator list (agency only)');
    expect(cell.getAttribute('title')).toContain('suppresses agency dialling');
  });

  it('leaves the other three sources alone', async () => {
    // Only `regulator` carried the misreading; renaming the rest would be churn
    // and would drift this page from `types/dnc.ts` for no gain.
    mocks.listDncEntries.mockResolvedValue(page([entry({ source: 'agent' })]));

    render(<DncPage />);

    expect(await screen.findByText('Marked by an agent')).toBeTruthy();
  });
});

describe('DNC — attribution', () => {
  it('resolves added_by to a person', async () => {
    render(<DncPage />);

    expect(await screen.findByText('Priya Menon')).toBeTruthy();
  });

  it('says Unattributed rather than leaving a blank', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({ added_by: null })]));

    render(<DncPage />);

    // Older rows genuinely lost attribution; a blank cell would
    // read as a rendering fault instead of as the missing data it is.
    expect(await screen.findByText('Unattributed')).toBeTruthy();
  });

  it('falls back to the id for someone no longer on the team', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({ added_by: 'user-gone' })]));

    render(<DncPage />);

    expect(await screen.findByText('user-gone')).toBeTruthy();
  });
});

describe('DNC — bulk add, at a scope the operator chose (DS1)', () => {
  async function typeNumbers(value = '+911111111111\n+912222222222, +913333333333') {
    fireEvent.change(await screen.findByLabelText(/add numbers/i), { target: { value } });
  }

  it('preselects no scope: Add waits for a choice, and says so', async () => {
    render(<DncPage />);
    await typeNumbers();

    const add = screen.getByRole('button', { name: /add to do not call/i }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByTestId('dnc-add-scope-hint').textContent).toBe('Choose where to block them before adding.');
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).checked).toBe(false);
    fireEvent.click(add);
    expect(mocks.addDncEntries).not.toHaveBeenCalled();
  });

  it('sends every campaign as a stated scope, and says what it blocks', async () => {
    render(<DncPage />);
    await typeNumbers();
    fireEvent.click(screen.getByRole('radio', { name: 'Every campaign' }));
    expect(screen.getByTestId('dnc-add-scope-hint').textContent).toMatch(/No agency campaign in any account/);
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    await waitFor(() => expect(mocks.addDncEntries).toHaveBeenCalled());
    const [input] = mocks.addDncEntries.mock.calls[0]!;
    expect(input).toMatchObject({ phone_numbers: ['+911111111111', '+912222222222', '+913333333333'], scope: 'tenant' });
    expect(input.account_id).toBeUndefined();
    expect(input.campaign_id).toBeUndefined();
  });

  it('sends this account, named', async () => {
    render(<DncPage />);
    await typeNumbers();
    fireEvent.click(screen.getByRole('radio', { name: 'North account' }));
    expect(screen.getByTestId('dnc-add-scope-hint').textContent).toMatch(/No campaign of the North account will dial these numbers.*other accounts can still/);
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    await waitFor(() => expect(mocks.addDncEntries).toHaveBeenCalled());
    expect(mocks.addDncEntries.mock.calls[0]![0]).toMatchObject({ scope: 'account', account_id: 'account-1' });
  });

  it('sends one campaign only once a campaign is picked, and lists finished campaigns as such', async () => {
    render(<DncPage />);
    await typeNumbers();
    fireEvent.click(screen.getByRole('radio', { name: 'One campaign' }));
    const picker = screen.getByLabelText('Campaign');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Q3 Renewals (completed)' })).toBeTruthy());
    expect((screen.getByRole('button', { name: /add to do not call/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(picker, { target: { value: 'camp-1' } });
    expect(screen.getByTestId('dnc-add-scope-hint').textContent).toBe('Only Q4 Renewals stops dialling these numbers. Every other campaign can still call them.');
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    await waitFor(() => expect(mocks.addDncEntries).toHaveBeenCalled());
    const [input] = mocks.addDncEntries.mock.calls[0]!;
    expect(input).toMatchObject({ scope: 'campaign', campaign_id: 'camp-1' });
    expect(input.account_id).toBeUndefined();
  });

  it('does not offer every campaign to an admin of one account (DS3)', async () => {
    mocks.useAuth.mockReturnValue({ memberships: memberships('account', 'account_admin') });
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', accounts: [{ id: 'account-1', name: 'North' }],
    });

    render(<DncPage />);
    await typeNumbers();
    expect(screen.queryByRole('radio', { name: 'Every campaign' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'North account' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'One campaign' })).toBeTruthy();
  });

  it('reports already-present as a success, not a failure', async () => {
    mocks.addDncEntries.mockResolvedValue(summary({ added: 412, already_present: 88, invalid: 3 }));

    render(<DncPage />);
    await typeNumbers('+911111111111');
    fireEvent.click(screen.getByRole('radio', { name: 'Every campaign' }));
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    // Re-uploading a regulator list is the expected case; 88 duplicates is the
    // answer, not 88 errors.
    expect((await screen.findByTestId('dnc-add-summary')).textContent)
      .toBe('412 added, 88 already listed, 3 not usable.');
  });

  it('says which numbers were already blocked more widely (DS4)', async () => {
    mocks.addDncEntries.mockResolvedValue(summary({
      added: 1, already_present: 0, already_covered: 3, invalid: 0,
      results: [
        { input: 'a', outcome: 'already_covered', scope: 'tenant' },
        { input: 'b', outcome: 'already_covered', scope: 'tenant' },
        { input: 'c', outcome: 'already_covered', scope: 'account' },
        { input: 'd', outcome: 'added', scope: 'campaign' },
      ],
    }));

    render(<DncPage />);
    await typeNumbers('+911111111111');
    fireEvent.click(screen.getByRole('radio', { name: 'One campaign' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Q4 Renewals' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-1' } });
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    expect((await screen.findByTestId('dnc-add-summary')).textContent).toBe(
      '1 added, 0 already listed, 2 already blocked in every campaign, '
      + '1 already blocked in every campaign of the North account, 0 not usable.',
    );
  });
});

describe('DNC — removal is permission-gated and consequence-aware', () => {
  it('hides the add box and remove control from a viewer', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
      accounts: [],
    });

    render(<DncPage />);

    await screen.findByText('+919820041772');
    expect(screen.queryByLabelText(/add numbers/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /remove \+919820041772/i })).toBeNull();
  });

  it('confirms before removing, and says who will be able to dial it again (DS5)', async () => {
    render(<DncPage />);

    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));

    // The question carries the scope as well as the body does.
    expect(await screen.findByText('Let every campaign dial this number again?')).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toMatch(/agency campaigns in every account will be able to dial it again/));
    expect(document.body.textContent).toMatch(/No other entry blocks it\./);
    expect(document.body.textContent).not.toMatch(/make this number callable again/i);
    expect(mocks.removeDncEntry).not.toHaveBeenCalled();
    // It looked the number up to say what else blocks it.
    expect(mocks.listDncEntries).toHaveBeenCalledWith({ phone: '+919820041772', limit: 50 }, 'tenant-1', 'account-1');

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() =>
      expect(mocks.removeDncEntry).toHaveBeenCalledWith('dnc-1', 'tenant-1', 'account-1'),
    );
  });

  it('removing an every-campaign entry says which narrower entries still block the number', async () => {
    const campaignEntry = entry({
      id: 'dnc-2', campaign_id: 'camp-1', scope: 'campaign', campaign_name: 'Q4 Renewals', account_name: 'North',
    });
    mocks.listDncEntries.mockImplementation(async (params: { phone?: string }) => (
      params.phone ? page([entry(), campaignEntry]) : page([entry()])
    ));

    render(<DncPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));

    await waitFor(() => expect(document.body.textContent).toMatch(/It stays blocked by another entry: Campaign: Q4 Renewals\./));
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    expect(mocks.showToast.mock.calls[0]![0]).toBe(
      '+919820041772 removed — agency campaigns in every account can dial it again, except where another entry still blocks it.',
    );
  });

  it('removing a campaign entry names the campaign that may dial again', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({
      campaign_id: 'camp-1', scope: 'campaign', campaign_name: 'Q4 Renewals', account_name: 'North',
    })]));

    render(<DncPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));

    expect(await screen.findByText('Let Q4 Renewals dial this number again?')).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toMatch(/\(Campaign: Q4 Renewals\), and Q4 Renewals will be able to dial it again/));
  });

  it('an account admin is told only about their account\'s entries, and Remove waits for the look-up', async () => {
    mocks.useAuth.mockReturnValue({ memberships: memberships('account', 'account_admin') });
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', accounts: [] });
    let answer: (v: unknown) => void = () => {};
    mocks.listDncEntries.mockImplementation((params: { phone?: string }) => (
      params.phone ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(page([entry({ scope: 'account', account_id: 'account-1' })]))
    ));

    render(<DncPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));
    expect(await screen.findByText('Checking what else blocks this number…')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^remove$/i }) as HTMLButtonElement).disabled).toBe(true);

    answer(page([]));
    await waitFor(() => expect(document.body.textContent).toMatch(/No other entry for your account blocks it\./));
    expect((screen.getByRole('button', { name: /^remove$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the scope in the toast, which is what stays on screen afterwards', async () => {
    render(<DncPage />);

    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/No other entry blocks it/));
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    const [message, variant] = mocks.showToast.mock.calls[0]!;
    expect(variant).toBe('success');
    expect(message).toBe('+919820041772 removed — agency campaigns in every account can dial it again.');
    // The unqualified sentence, which reads as platform-wide on a list that
    // binds one product.
    expect(message).not.toMatch(/^\+\d+ can be called again\.?$/);
  });
});

describe('DNC — pagination after a mutation', () => {
  it('steps back a page when the last row on a later page is removed', async () => {
    // Page two, one row on it, 51 rows in total.
    mocks.listDncEntries.mockResolvedValue({
      entries: [entry()],
      total: 51,
      limit: 50,
      offset: 50,
    });

    render(<DncPage />);
    await screen.findByText('+919820041772');

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => expect(mocks.listDncEntries).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: /remove \+919820041772/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/No other entry blocks it/));
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    // Reloading the same offset would land past the end, and the pager only
    // renders when there are rows — stranding the operator on an empty state
    // with no way back to the entries that still exist.
    await waitFor(() => {
      const offsets = tableCalls().map(([params]) => params.offset);
      expect(offsets[offsets.length - 1]).toBeLessThan(50);
    });
  });

  it('does not fire a stale request when adding from a later page', async () => {
    mocks.listDncEntries.mockResolvedValue({
      entries: [entry()],
      total: 51,
      limit: 50,
      offset: 50,
    });

    render(<DncPage />);
    await screen.findByText('+919820041772');
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => expect(mocks.listDncEntries).toHaveBeenCalledTimes(2));
    const before = mocks.listDncEntries.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/add numbers/i), {
      target: { value: '+911111111111' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Every campaign' }));
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    await waitFor(() => expect(mocks.addDncEntries).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.listDncEntries.mock.calls.length).toBeGreaterThan(before),
    );

    // Exactly one reload, at offset 0. Calling `load()` alongside `setOffset(0)`
    // would fire a second request still closed over the old offset, and the
    // later-settling one wins — page-2 rows under a page-1 pager.
    const after = mocks.listDncEntries.mock.calls.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]![0].offset).toBe(0);
  });
});

describe('DNC — searching the list', () => {
  /**
   * The server reads the text (`dncPhoneSearch`): any common form of the whole number, or the
   * digits a number ends in. The page sends what was typed and says which forms work, so a
   * supervisor checking a customer's ten digits is not left believing they must type `+91`.
   */
  it('says which forms the search takes and sends the text as typed', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');
    const box = screen.getByRole('textbox', { name: 'Search the Do Not Call list by number' });
    expect(box.getAttribute('placeholder')).toBe('Whole number, or last 4+ digits');

    mocks.listDncEntries.mockResolvedValue(page([]));
    fireEvent.change(box, { target: { value: ' 98200 41772 ' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(mocks.listDncEntries.mock.calls.at(-1)![0]).toMatchObject({ phone: '98200 41772', offset: 0 }));
    expect(await screen.findByText(/Type the whole number, in any format, or at least its last 4 digits/)).toBeTruthy();
  });

  /**
   * Too few digits is the server's 400 (`dncSearchShortfall`, the same rule). The page checks it
   * first and says so under the box: nothing is sent, so no Retry resends text that cannot run,
   * and the rows below stay the last search's, never read as this text's matches.
   */
  it('says under the box when a search has too few digits, and sends nothing', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');
    const box = screen.getByRole('textbox', { name: 'Search the Do Not Call list by number' });
    const sent = mocks.listDncEntries.mock.calls.length;

    fireEvent.change(box, { target: { value: '060' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Type at least 4 digits of the number.');
    expect(box.getAttribute('aria-invalid')).toBe('true');

    // A + number short of its calling code and 4 more digits has its own words.
    fireEvent.change(box, { target: { value: '+44 207' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Type at least 4 digits after +44, or leave off the + to search by the last digits.',
    );

    expect(mocks.listDncEntries.mock.calls.length).toBe(sent);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByText('+919820041772')).toBeTruthy();

    // Enough digits: sent, and the message goes.
    mocks.listDncEntries.mockResolvedValue(page([]));
    fireEvent.change(box, { target: { value: '+44 2079' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocks.listDncEntries.mock.calls.at(-1)![0]).toMatchObject({ phone: '+44 2079', offset: 0 }));
    expect(screen.queryByText(/leave off the \+/)).toBeNull();
  });

  it('a failed read shows the error and no rows, not the last answer’s rows', async () => {
    render(<DncPage />);
    await screen.findByText('+919820041772');
    const box = screen.getByRole('textbox', { name: 'Search the Do Not Call list by number' });

    mocks.listDncEntries.mockRejectedValue(new Error('Could not reach the server.'));
    fireEvent.change(box, { target: { value: '41772' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText('Could not reach the server.')).toBeTruthy();
    expect(screen.queryByText('+919820041772')).toBeNull();
    // Not "No match": the read failed, it did not come back empty.
    expect(screen.queryByText('No match')).toBeNull();
  });
});
