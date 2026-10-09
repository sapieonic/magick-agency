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
  useTeam: vi.fn(),
  listDncEntries: vi.fn(),
  addDncEntries: vi.fn(),
  removeDncEntry: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../contexts/ToastContext', () => ({
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
    ...over,
  };
}

function page(entries: DncEntry[], total = entries.length) {
  return { entries, total, limit: 50, offset: 0 };
}

function summary(over: Partial<DncAddSummary> = {}): DncAddSummary {
  return { added: 1, already_present: 0, invalid: 0, results: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
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
   * The dial-time set is `dnc:{tenantId}`, filled from `listTenantWidePhones`
   * (`account_id IS NULL AND campaign_id IS NULL`); the import-time filter is
   * `findSuppressed`, whose predicate matches a row scoped to the account or the
   * campaign being imported. That difference is what these pin.
   */
  it('shows a tenant-wide entry as enforced across every agency campaign', async () => {
    render(<DncPage />);

    expect(await screen.findByTestId('dnc-scope-tenant')).toBeTruthy();
    expect(screen.getByTestId('dnc-scope-tenant').textContent).toBe('Every campaign');
    const title = screen.getByTestId('dnc-scope-tenant').getAttribute('title') ?? '';
    // The only scope that may claim the dial-time block list.
    expect(title).toContain('Enforced for all agency dialing');
    // OVER-claim guard, and the widest claim on the page. "Enforced
    // everywhere" is what this said, and everywhere is not what it is: the
    // dial-time set is read by the agency pacing engine alone.
    expect(title).not.toMatch(/enforced everywhere/i);
    expect(title).toContain('does not stop AI calls or broadcasts');
  });

  it('shows a campaign-scoped entry as enforced for one campaign — not as unenforced', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({ campaign_id: 'camp-9' })]));

    render(<DncPage />);

    const badge = await screen.findByTestId('dnc-scope-campaign');
    expect(badge.textContent).toBe('One campaign');
    const title = badge.getAttribute('title') ?? '';
    // UNDER-claim guard: it must not say the row does nothing. This is the exact
    // sentence that shipped, beside a suppression that is live.
    expect(title).not.toMatch(/does not stop any call/i);
    expect(title).not.toMatch(/not enforced/i);
    expect(badge.textContent).not.toMatch(/not enforced/i);
    expect(title).toContain('Enforced for one campaign only');
    // OVER-claim guard: it must not imply the workspace-wide block.
    expect(title).toContain('NOT in the dialer’s block list');
    expect(title).toContain('every other campaign');
  });

  it('shows an account-scoped entry as import-only, which a campaign row is not', async () => {
    mocks.listDncEntries.mockResolvedValue(page([entry({ account_id: 'account-9' })]));

    render(<DncPage />);

    const badge = await screen.findByTestId('dnc-scope-account');
    expect(badge.textContent).toBe('One account');
    const title = badge.getAttribute('title') ?? '';
    expect(title).toContain('at roster import only');
    // OVER-claim guard: no mark creates an account-scoped row, so nothing swept
    // the contacts already imported and they remain dialable.
    expect(title).toContain('NOT in the dialer’s block list');
    expect(title).toContain('already imported');
    // And it is a DIFFERENT answer from the campaign one, not a shared "narrow"
    // bucket — collapsing the two is how the old boolean got this wrong.
    expect(badge.textContent).not.toBe('One campaign');
  });

  it('treats a row carrying both ids as campaign-scoped, the narrower reading', async () => {
    mocks.listDncEntries.mockResolvedValue(
      page([entry({ account_id: 'account-9', campaign_id: 'camp-9' })]),
    );

    render(<DncPage />);

    expect(await screen.findByTestId('dnc-scope-campaign')).toBeTruthy();
    expect(screen.queryByTestId('dnc-scope-account')).toBeNull();
  });

  it('never tells an operator that a scoped entry stops nothing', async () => {
    // The page-level copy has to agree with the column, or the banner re-states
    // the defect the column just fixed.
    mocks.listDncEntries.mockResolvedValue(page([entry({ campaign_id: 'camp-9' })]));

    render(<DncPage />);
    await screen.findByTestId('dnc-scope-campaign');

    // Positive first, so the negatives below cannot pass vacuously on a guide
    // that simply failed to render.
    expect(document.body.textContent).toMatch(/scoped to one campaign or account IS enforced/);
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
    expect(document.body.textContent).toMatch(
      /does not apply to AI calls, broadcasts or the Softphone/,
    );
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
    expect(cell.getAttribute('title')).toContain('suppresses agency dialing');
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

describe('DNC — bulk add', () => {
  it('sends every number and no account scope', async () => {
    render(<DncPage />);

    fireEvent.change(await screen.findByLabelText(/add numbers/i), {
      target: { value: '+911111111111\n+912222222222, +913333333333' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    await waitFor(() => expect(mocks.addDncEntries).toHaveBeenCalled());
    const [input] = mocks.addDncEntries.mock.calls[0]!;
    expect(input.phone_numbers).toEqual(['+911111111111', '+912222222222', '+913333333333']);
    // An account-scoped row would show on this list and suppress nothing.
    expect(input.account_id).toBeUndefined();
  });

  it('reports already-present as a success, not a failure', async () => {
    mocks.addDncEntries.mockResolvedValue(summary({ added: 412, already_present: 88, invalid: 3 }));

    render(<DncPage />);

    fireEvent.change(await screen.findByLabelText(/add numbers/i), {
      target: { value: '+911111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add to do not call/i }));

    // Re-uploading a regulator list is the expected case; 88 duplicates is the
    // answer, not 88 errors.
    expect(await screen.findByText(/already listed/i)).toBeTruthy();
    expect(screen.getByText('88')).toBeTruthy();
  });
});

describe('DNC — removal is permission-gated and consequence-aware', () => {
  it('hides the add box and remove control from a viewer', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
    });

    render(<DncPage />);

    await screen.findByText('+919820041772');
    expect(screen.queryByLabelText(/add numbers/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /remove \+919820041772/i })).toBeNull();
  });

  it('confirms before removing, and says who will be able to dial it', async () => {
    render(<DncPage />);

    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));

    // The question carries the scope as well as the body does. The title is what
    // frames the decision, so "Make this number callable again?" promised a
    // change this page cannot make, before the body had a chance to qualify it.
    expect(await screen.findByText(/let agency campaigns dial this number again\?/i)).toBeTruthy();
    expect(document.body.textContent).toMatch(/agency campaigns will be able to dial it again/);
    expect(document.body.textContent).not.toMatch(/make this number callable again/i);
    expect(mocks.removeDncEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() =>
      expect(mocks.removeDncEntry).toHaveBeenCalledWith('dnc-1', 'tenant-1', 'account-1'),
    );
  });

  it('keeps the scope in the toast, which is what stays on screen afterwards', async () => {
    /**
     * The over-claim survived the first pass on the one sentence that outlives
     * the act. The dialog was narrowed to "agency campaigns will be able to dial
     * it again"; the toast that fires on confirm still said the number "can be
     * called again", full stop. That is the sentence the operator actually reads
     * — after the row is gone and the dialog has closed — about the one
     * interaction on this page that changes who gets called.
     */
    render(<DncPage />);

    fireEvent.click(await screen.findByRole('button', { name: /remove \+919820041772/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    const [message, variant] = mocks.showToast.mock.calls[0]!;
    expect(variant).toBe('success');
    expect(message).toContain('+919820041772');
    expect(message).toMatch(/agency campaigns can dial it again/);
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
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    // Reloading the same offset would land past the end, and the pager only
    // renders when there are rows — stranding the operator on an empty state
    // with no way back to the entries that still exist.
    await waitFor(() => {
      const offsets = mocks.listDncEntries.mock.calls.map(([params]) => params.offset);
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
