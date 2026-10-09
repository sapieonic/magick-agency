import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { AgencyKeysetPage, AgencyRosterContact } from '../../types/agency-spine';

/**
 * The campaign roster.
 *
 * This URL used to render an upload form — its own heading read "Add contacts"
 * — so the one page in the product that named the contacts was the one place
 * you could not see them. What is pinned here is the half that made that worth
 * fixing: a contact suppressed before it was ever dialed has no call and no
 * attempt, so it appears in no other list anywhere, and it is the row a
 * compliance question is usually about.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getCampaignContacts: vi.fn(),
  downloadSpineCsv: vi.fn(),
  // The retry dialog is mounted only while open and owns these two reads.
  retryPreview: vi.fn(),
  createRetry: vi.fn(),
  usePhoneNumbers: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  retryPreview: mocks.retryPreview,
  createRetry: mocks.createRetry,
}));
vi.mock('../../api/agencySpine', () => ({
  getCampaignContacts: mocks.getCampaignContacts,
  downloadSpineCsv: mocks.downloadSpineCsv,
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: mocks.usePhoneNumbers }));

import RosterPage from '../../pages/agency/AgencyCampaignRosterPage';

const COMPLETED: AgencyRosterContact = {
  id: 'contact-1', phone_e164: '+919876500001', state: 'completed', attempt_count: 3,
  our_fault_attempts: 0, last_outcome: 'connected', last_disposition: 'not_interested',
  next_attempt_at: '2026-08-17T09:00:00.000Z', suppressed_reason: null, timezone: null,
  csv_line_number: 12, created_at: '2026-08-17T08:00:00.000Z',
  updated_at: '2026-08-17T09:30:00.000Z',
};

/**
 * Never dialed. No attempt row, no `webrtc_calls` row — invisible everywhere
 * else in the product.
 */
const SUPPRESSED: AgencyRosterContact = {
  ...COMPLETED, id: 'contact-2', phone_e164: '+919876500002', state: 'suppressed',
  attempt_count: 0, last_outcome: null, last_disposition: null,
  suppressed_reason: 'dnc', csv_line_number: 41,
};

/** Redialed after one of OUR faults, which must not read as a customer retry. */
const OUR_FAULT: AgencyRosterContact = {
  ...COMPLETED, id: 'contact-3', phone_e164: '+919876500003', state: 'pending',
  attempt_count: 1, our_fault_attempts: 2, last_outcome: 'orphaned',
};

function page(rows: AgencyRosterContact[], nextCursor: string | null = null): AgencyKeysetPage<AgencyRosterContact> {
  return { rows, next_cursor: nextCursor, limit: 50 };
}

/**
 * `MemoryRouter` never touches `window.location`, so the query string has to be
 * read from the router itself. A probe rendered beside the page is the only way
 * to assert the round trip end to end — reading the component's state instead
 * would prove the filters are held somewhere, which is exactly the property
 * that was true before and is not what changed.
 */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

function currentQuery(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
}

function renderPage(query = '') {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1/contacts${query}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/agency/campaigns/:id/contacts" element={<RosterPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin',
  });
  mocks.getAgencyCampaign.mockResolvedValue({
    id: 'camp-1',
    name: 'Q3 Renewals',
    status: 'stopped',
    // The disposition filter's vocabulary is the campaign's own catalog ∪ the
    // built-ins, which is the server's rule for `last_disposition` exactly.
    disposition_catalog: [{ code: 'not_interested', label: 'Not interested' }],
  });
  mocks.getCampaignContacts.mockResolvedValue(page([COMPLETED, SUPPRESSED, OUR_FAULT]));
  mocks.usePhoneNumbers.mockReturnValue({
    phoneNumbers: [], loading: false, error: null, reload: vi.fn(), defaultNumber: null,
  });
  mocks.retryPreview.mockResolvedValue({
    matched: 812,
    by_last_outcome: { no_answer: 500, busy: 312 },
    by_last_disposition: { __none__: 812 },
    excluded: { dnc: 14, invalid: 3 },
    parent_contacts_total: 4000,
    retry_generation: 0,
    max_seed_rows: 100_000,
  });
});

afterEach(cleanup);

describe('this page lists contacts — it is not the upload form', () => {
  it('renders the roster on a stopped campaign', async () => {
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    expect(screen.getByText('+919876500001')).toBeTruthy();
    // The upload is still reachable, as an ACTION rather than as the page.
    expect(screen.getByText('Add contacts').closest('a')?.getAttribute('href'))
      .toBe('/agency/campaigns/camp-1/contacts/add');
  });

  it('links each contact to its own drill-down', async () => {
    renderPage();
    const row = await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    expect(within(row).getByText('+919876500001').closest('a')?.getAttribute('href'))
      .toBe('/agency/campaigns/camp-1/contacts/contact-1');
  });
});

describe('suppressed contacts', () => {
  it('shows a suppressed contact with the reason spelled out, not as a code', async () => {
    renderPage();
    const row = await screen.findByTestId(`roster-row-${SUPPRESSED.id}`);
    expect(within(row).getByText('On the Do Not Call list')).toBeTruthy();
    // `dnc` is not self-evident to whoever reads the compliance answer.
    expect(within(row).queryByText('dnc')).toBeNull();
  });

  it('says "never dialed" rather than leaving the outcome blank', async () => {
    renderPage();
    const row = await screen.findByTestId(`roster-row-${SUPPRESSED.id}`);
    expect(within(row).getByText('Never dialed')).toBeTruthy();
  });

  it('has a one-click filter for exactly these rows', async () => {
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByTestId('roster-suppressed-shortcut'));

    await waitFor(() => {
      expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
        'camp-1', { state: ['suppressed'] }, { limit: 50 }, 'tenant-1', 'account-1',
      );
    });
  });

  it('filters by the reason it was suppressed', async () => {
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByLabelText('On the Do Not Call list'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
        'camp-1', { suppressed_reason: ['dnc'] }, { limit: 50 }, 'tenant-1', 'account-1',
      );
    });
  });
});

describe('the two attempt counters are not the same number', () => {
  it('shows our-fault redials separately from the customer’s retry budget', async () => {
    renderPage();
    const row = await screen.findByTestId(`roster-row-${OUR_FAULT.id}`);
    // Folding them together would say we called this person three times when
    // the campaign only permitted one of those to count against them.
    expect(within(row).getByText('+2')).toBeTruthy();
    expect(within(row).getByText('1')).toBeTruthy();
  });
});

describe('next attempt', () => {
  it('is shown only where another call can actually happen', async () => {
    renderPage();
    const suppressed = await screen.findByTestId(`roster-row-${SUPPRESSED.id}`);
    const pending = screen.getByTestId(`roster-row-${OUR_FAULT.id}`);

    // The column holds whatever the last scheduling write left behind on a
    // terminal row; rendering it as a date promises a call that will never be
    // placed.
    const suppressedCells = within(suppressed).getAllByRole('cell');
    expect(suppressedCells[suppressedCells.length - 1]!.textContent).toBe('—');
    const pendingCells = within(pending).getAllByRole('cell');
    expect(pendingCells[pendingCells.length - 1]!.textContent).not.toBe('—');
  });
});

describe('export', () => {
  it('takes the filters currently on screen', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({
      blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1,
    });
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByTestId('roster-suppressed-shortcut'));
    await waitFor(() => expect(mocks.getCampaignContacts).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => {
      expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
        'camp-1', 'contacts', { state: ['suppressed'] }, 'tenant-1', 'account-1',
      );
    });
  });

  it('is hidden from a role that cannot supervise', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'operator',
    });
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    expect(screen.queryByText('Export CSV')).toBeNull();
  });
});

/**
 * ── This screen is a section of the campaign workspace ──────────
 *
 * The bar is what makes it one, and it is rendered by each page rather than by
 * a shared route layout — so without an assertion here it could be deleted
 * from this one file and every suite in the repo would stay green. That is the
 * whole reason this test exists.
 */
describe('the campaign section bar', () => {
  it('renders the bar and marks Contacts as the current section', async () => {
    renderPage();

    const tab = await screen.findByTestId('campaign-tab-contacts');
    expect(tab.getAttribute('aria-current')).toBe('page');
    // Its neighbours are reachable from here — the point of the bar is that
    // getting to another section does not mean going back through the campaign.
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
  });
});

/**
 * ── The filters live in the URL (retry campaigns, slice S4) ────────────────
 *
 * They used to be component state and could not leave the tab. Putting them in
 * the query string is what makes the selector rule literally true rather than a
 * coincidence of two representations: "the supervisor narrows the Contacts tab
 * until it shows the rows they mean, presses Retry these contacts, and the
 * query string they were already looking at becomes the selector."
 */
describe('the filters round-trip through the URL', () => {
  it('applies last_disposition from the URL on first render', async () => {
    renderPage('?last_disposition=not_interested');

    await waitFor(() => {
      expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
        'camp-1',
        { last_disposition: ['not_interested'] },
        { limit: 50 },
        'tenant-1',
        'account-1',
      );
    });
  });

  it('fills the draft controls from a link, so Apply does not silently widen', async () => {
    renderPage('?last_disposition=not_interested');
    const chip = (await screen.findByLabelText('Not interested')) as HTMLInputElement;
    expect(chip.checked).toBe(true);
  });

  it('writes an applied disposition filter back out to the URL', async () => {
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(await screen.findByLabelText('Not interested'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
        'camp-1',
        { last_disposition: ['not_interested'] },
        { limit: 50 },
        'tenant-1',
        'account-1',
      );
    });
    // The round trip: the filter that was applied is now readable from the URL.
    expect(currentQuery().getAll('last_disposition')).toEqual(['not_interested']);
  });

  it('removes a cleared filter from the URL rather than leaving it behind', async () => {
    renderPage('?state=suppressed&phone=98765');
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByText('Clear'));

    await waitFor(() => expect(currentQuery().toString()).toBe(''));
    await waitFor(() => {
      expect(mocks.getCampaignContacts).toHaveBeenLastCalledWith(
        'camp-1', {}, { limit: 50 }, 'tenant-1', 'account-1',
      );
    });
  });

  it('offers a built-in code the catalog no longer holds', async () => {
    // An operator may have dropped `voicemail` from the catalog AFTER calls were
    // filed under it, and those contacts are exactly the ones a supervisor is
    // looking for.
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    expect(await screen.findByLabelText('Voicemail')).toBeTruthy();
  });

  it('counts the disposition group in the filter badge', async () => {
    renderPage('?state=suppressed&last_disposition=not_interested');
    await waitFor(() => expect(screen.getByText('2 active')).toBeTruthy());
  });

  it('carries the disposition filter into the CSV export', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({
      blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1,
    });
    renderPage('?last_disposition=not_interested');
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => {
      expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
        'camp-1', 'contacts', { last_disposition: ['not_interested'] }, 'tenant-1', 'account-1',
      );
    });
  });
});

describe('Retry these contacts', () => {
  it('carries the active filters into the dialog as a selector', async () => {
    renderPage('?state=exhausted&last_disposition=not_interested');
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByTestId('roster-retry-action'));

    await waitFor(() => {
      expect(mocks.retryPreview).toHaveBeenCalledWith(
        'camp-1',
        { state: ['exhausted'], last_disposition: ['not_interested'] },
        'tenant-1',
        'account-1',
      );
    });
  });

  it('strips phone before building the selector, and says it did', async () => {
    // `phone` is a lookup, not a cohort, and the server answers 400 on the WHOLE
    // request for any key it does not recognise — so a leaked filter is not a
    // widened cohort, it is a refused retry. Silently narrowing or silently
    // widening are both worse than saying so.
    renderPage('?state=exhausted&phone=98765');
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);

    fireEvent.click(screen.getByTestId('roster-retry-action'));

    await waitFor(() => {
      expect(mocks.retryPreview).toHaveBeenCalledWith(
        'camp-1', { state: ['exhausted'] }, 'tenant-1', 'account-1',
      );
    });
    const notice = await screen.findByTestId('retry-dropped-filters');
    expect(notice.textContent).toContain('phone-number search');
  });

  it('surfaces the DNC and invalid exclusions on the preview', async () => {
    renderPage('?state=exhausted');
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    fireEvent.click(screen.getByTestId('roster-retry-action'));

    const excluded = await screen.findByTestId('retry-excluded');
    expect(excluded.textContent).toContain('Do Not Call');
    expect(excluded.textContent).toContain('14');
  });

  it('is hidden from a role that cannot create a campaign', async () => {
    // The server names BOTH permissions on the create. `operator` holds neither, and
    // a button that renders and then 403s is worse than no button.
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'operator',
    });
    renderPage();
    await screen.findByTestId(`roster-row-${COMPLETED.id}`);
    expect(screen.queryByTestId('roster-retry-action')).toBeNull();
  });
});
