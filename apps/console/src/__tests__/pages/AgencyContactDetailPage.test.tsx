import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { AgencyAttempt, AgencyContactDetail } from '../../types/agency-spine';

/**
 * The per-contact drill-down — the "why was this number called four
 * times" view.
 *
 * Two things are pinned here that a plausible implementation gets wrong:
 *
 * 1. **`context` is filtered through the campaign's own display rules.** The
 *    operator marks columns not-for-screen for the AGENT floor; this screen has
 *    a wider audience, so it must honour the same list rather than spreading
 *    the row. The design warning — "a field in `context` is a field on an
 *    agent's screen the moment anyone changes the render rules" — is about
 *    exactly this moment.
 *
 * 2. **A contact with no attempts is a real, explicable state**, not an error
 *    and not an empty table: a suppressed number was never dialed.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getCampaignContact: vi.fn(),
  getCampaignAttempts: vi.fn(),
  // Typed with the parameter it really takes: inferred from `() => true`
  // the mock is zero-arg, and a per-capability `mockImplementation`
  // then fails to typecheck (vitest does not typecheck, so only `tsc`
  // catches it).
  isEnabled: vi.fn((_capability: string) => true),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
vi.mock('../../api/agencySpine', () => ({
  getCampaignContact: mocks.getCampaignContact,
  getCampaignAttempts: mocks.getCampaignAttempts,
}));

import ContactDetailPage from '../../pages/agency/AgencyContactDetailPage';

const CONTACT: AgencyContactDetail = {
  id: 'contact-1', phone_e164: '+919876500001', state: 'completed', attempt_count: 4,
  our_fault_attempts: 0, last_outcome: 'connected', last_disposition: 'not_interested',
  next_attempt_at: '2026-08-17T09:00:00.000Z', suppressed_reason: null, timezone: null,
  csv_line_number: 12, created_at: '2026-08-17T08:00:00.000Z',
  updated_at: '2026-08-17T09:30:00.000Z',
  context: {
    'Full Name': 'A Person',
    'Loan Ref': 'L-42',
    // The operator marked this `hidden` — an internal score the agent floor was
    // never meant to see, and neither is this screen.
    'Risk Score': '0.91',
  },
};

const ATTEMPT: AgencyAttempt = {
  id: 'attempt-1', contact_id: 'contact-1', campaign_id: 'camp-1', attempt_number: 4,
  phone_e164: '+919876500001', caller_id: '+919000000001',
  agent_user_id: 'ac1f9d2e-1111-4222-8333-444455556666',
  reserved_agent_id: 'session-1', state: 'ended', outcome: 'connected',
  agent_name: 'Ravi Menon',
  disposition_code: 'not_interested', notes: 'asked us to call after 6pm',
  callback_at: null, dispositioned_by_user_id: 'supervisor-2',
  dispositioned_at: '2026-08-17T10:00:00.000Z', dispositioned_on_behalf: true,
  webrtc_call_id: 'call-9', dialed_at: '2026-08-17T09:59:00.000Z',
  answered_at: '2026-08-17T09:59:10.000Z', bridged_at: '2026-08-17T09:59:12.000Z',
  ended_at: '2026-08-17T09:59:59.000Z', talk_seconds: 47, wrapup_seconds: 20,
  created_at: '2026-08-17T09:58:00.000Z',
};

const ABANDONED: AgencyAttempt = {
  ...ATTEMPT, id: 'attempt-2', attempt_number: 3, agent_user_id: null, agent_name: null,
  reserved_agent_id: null, outcome: 'abandoned', disposition_code: null, notes: null,
  webrtc_call_id: null, bridged_at: null, talk_seconds: null,
  dispositioned_on_behalf: false, dispositioned_by_user_id: null,
  created_at: '2026-08-16T09:58:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/contacts/contact-1']}>
      <Routes>
        <Route path="/agency/campaigns/:id/contacts/:contactId" element={<ContactDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEnabled.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin',
  });
  mocks.getAgencyCampaign.mockResolvedValue({
    id: 'camp-1', name: 'Q3 Renewals', status: 'stopped',
    context_display: { hero: ['Full Name'], hidden: ['Risk Score'] },
  });
  mocks.getCampaignContact.mockResolvedValue(CONTACT);
  mocks.getCampaignAttempts.mockResolvedValue({
    rows: [ATTEMPT, ABANDONED], next_cursor: null, limit: 100,
  });
});

afterEach(cleanup);

describe('the uploaded CSV columns', () => {
  it('renders the columns the campaign shows', async () => {
    renderPage();
    const block = await screen.findByTestId('contact-context');
    expect(within(block).getByText('Full Name')).toBeTruthy();
    expect(within(block).getByText('A Person')).toBeTruthy();
    expect(within(block).getByText('Loan Ref')).toBeTruthy();
  });

  it('does NOT render a column the campaign marked hidden', async () => {
    renderPage();
    await screen.findByTestId('contact-context');
    // The whole of privacy decision 1. Marked not-for-screen for the agent
    // floor, and this screen has a wider audience than that one.
    expect(screen.queryByText('Risk Score')).toBeNull();
    expect(screen.queryByText('0.91')).toBeNull();
  });

  it('withholds the columns entirely when the display rules could not be loaded', async () => {
    // The dangerous default: "no rules" means "render everything" at campaign
    // build time, and would put the excluded columns on screen here.
    mocks.getAgencyCampaign.mockRejectedValue(new Error('campaign unavailable'));
    renderPage();
    await screen.findByTestId('contact-context-unavailable');
    expect(screen.queryByText('Risk Score')).toBeNull();
    expect(screen.queryByText('Full Name')).toBeNull();
  });

  it('lists a column that was uploaded empty, rather than dropping it', async () => {
    mocks.getCampaignContact.mockResolvedValue({
      ...CONTACT,
      context: { 'Full Name': 'A Person', 'Alternate Phone': '', 'Notes From Branch': 'n/a' },
    });
    renderPage();
    const empties = await screen.findByTestId('contact-context-empty');
    // "What did you hold about me" is answered wrongly by a screen that
    // silently omits a column: the reader cannot tell an absent column from an
    // empty one. Collapsed, but present.
    expect(within(empties).getByText('Alternate Phone')).toBeTruthy();
    expect(within(empties).getByText('Notes From Branch')).toBeTruthy();
    expect(empties.textContent).toContain('2 columns were uploaded with no value');
  });

  it('does not claim "no additional columns" when every column is empty', async () => {
    mocks.getCampaignContact.mockResolvedValue({
      ...CONTACT, context: { 'Alternate Phone': '', 'Branch': '-' },
    });
    renderPage();
    await screen.findByTestId('contact-context-empty');
    // False on both counts: the columns exist and the campaign shows them.
    expect(screen.queryByText(/no additional columns/)).toBeNull();
  });

  it('says "loading", not "could not be loaded", while the campaign is in flight', async () => {
    // The campaign is fetched in its own effect; if it merely lands last, a
    // failure notice for a request still in flight is a false alarm on a
    // compliance screen.
    let release: (value: unknown) => void = () => {};
    mocks.getAgencyCampaign.mockReturnValue(new Promise((r) => { release = r; }));
    renderPage();
    await screen.findByTestId('contact-context-loading');
    expect(screen.queryByTestId('contact-context-unavailable')).toBeNull();

    release({
      id: 'camp-1', name: 'Q3 Renewals', status: 'stopped',
      context_display: { hero: ['Full Name'], hidden: ['Risk Score'] },
    });
    await screen.findByTestId('contact-context');
  });

  it('names the row of the uploaded file the contact came from', async () => {
    renderPage();
    await screen.findByTestId('contact-context');
    expect(screen.getByText('Row 12 of the uploaded file.')).toBeTruthy();
  });
});

describe('the attempt history', () => {
  it('shows every attempt, including one that never reached an agent', async () => {
    renderPage();
    await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    const abandoned = screen.getByTestId(`contact-attempt-${ABANDONED.id}`);
    expect(within(abandoned).getByText('No agent was free')).toBeTruthy();
    expect(within(abandoned).getByText('No call was connected')).toBeTruthy();
  });

  it('links a connected attempt to its recording', async () => {
    renderPage();
    const row = await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    // The AGENCY's call detail, keyed on the attempt — see the shell-boundary
    // block below.
    expect(within(row).getByText('Open call').closest('a')?.getAttribute('href'))
      .toBe(`/agency/campaigns/camp-1/attempts/${ATTEMPT.id}`);
  });

  it('shows the agent’s notes — frequently the actual answer to "why again"', async () => {
    renderPage();
    const row = await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(within(row).getByText('asked us to call after 6pm')).toBeTruthy();
  });

  it('marks a write-up filed by someone other than the agent on the call', async () => {
    renderPage();
    const row = await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(within(row).getByText('on behalf')).toBeTruthy();
  });

  it('asks for this contact’s attempts only', async () => {
    renderPage();
    await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(mocks.getCampaignAttempts).toHaveBeenCalledWith(
      'camp-1', { contact_id: 'contact-1' }, { limit: 50 }, 'tenant-1', 'account-1',
    );
  });
});

describe('the history is complete, or it says it is not', () => {
  it('pages instead of silently stopping, and drops the completeness claim', async () => {
    mocks.getCampaignAttempts.mockResolvedValueOnce({
      rows: [ATTEMPT], next_cursor: 'more-attempts', limit: 50,
    });
    renderPage();
    await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);

    // The heading must not claim completeness over a partial table. It used to
    // read "Every call attempt" above a fixed 100 rows with the cursor thrown
    // away — on the one page built to answer "how many times did you call me".
    expect(screen.queryByText('Every call attempt')).toBeNull();
    expect(screen.getByText('Call attempts')).toBeTruthy();

    mocks.getCampaignAttempts.mockResolvedValueOnce({
      rows: [ABANDONED], next_cursor: null, limit: 50,
    });
    fireEvent.click(screen.getByTestId('contact-attempts-more'));

    await screen.findByTestId(`contact-attempt-${ABANDONED.id}`);
    // Appended, not replaced.
    expect(screen.getByTestId(`contact-attempt-${ATTEMPT.id}`)).toBeTruthy();
    expect(mocks.getCampaignAttempts).toHaveBeenLastCalledWith(
      'camp-1', { contact_id: 'contact-1' },
      { cursor: 'more-attempts', limit: 50 }, 'tenant-1', 'account-1',
    );
  });

  it('claims completeness only when there is nothing more', async () => {
    renderPage();
    await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(screen.getByText('Every call attempt')).toBeTruthy();
    expect(screen.queryByTestId('contact-attempts-more')).toBeNull();
  });
});

describe('the agent is named', () => {
  it('renders the resolved name, not the UUID', async () => {
    renderPage();
    const row = await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(within(row).getByText('Ravi Menon')).toBeTruthy();
    // The id is 36 characters a supervisor can neither read nor recognise.
    expect(within(row).queryByText(ATTEMPT.agent_user_id!)).toBeNull();
  });

  it('falls back to the id rather than claiming there was no agent', async () => {
    // The server could not resolve the name (identity store degraded). The attempt
    // still HAD an agent, so "no agent" would be false — the id is a real, if
    // unreadable, answer.
    mocks.getCampaignAttempts.mockResolvedValue({
      rows: [{ ...ATTEMPT, agent_name: null }], next_cursor: null, limit: 50,
    });
    renderPage();
    const row = await screen.findByTestId(`contact-attempt-${ATTEMPT.id}`);
    expect(within(row).getByText(ATTEMPT.agent_user_id!)).toBeTruthy();
  });
});

describe('a suppressed contact', () => {
  beforeEach(() => {
    mocks.getCampaignContact.mockResolvedValue({
      ...CONTACT, state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 0,
    });
    mocks.getCampaignAttempts.mockResolvedValue({ rows: [], next_cursor: null, limit: 100 });
  });

  it('says why in a sentence, not as a table cell', async () => {
    renderPage();
    const banner = await screen.findByTestId('contact-suppressed');
    expect(banner.textContent).toContain('on the do not call list');
    expect(banner.textContent).toContain('No further calls will be placed');
  });

  it('explains the empty history rather than showing a bare empty table', async () => {
    renderPage();
    await screen.findByTestId('contact-suppressed');
    expect(screen.getByText('This number was never dialed')).toBeTruthy();
    expect(screen.getByText(/suppressed before any call was placed/)).toBeTruthy();
  });
});

describe('the recording link stays inside the agency workspace', () => {
  /**
   * ─── WHAT THE DEGRADATION WAS FOR, AND WHY IT IS GONE ────────────────────
   *
   * This link used to point at `/app/calls/dialer/history/:id`, wrapped in
   * `RequireCapability capability="calls.dialer"` while this page needs only
   * `agency.supervise`. A compliance reviewer holding the second without the
   * first is an ordinary person, not an edge case, and for them the link was a
   * trapdoor: it rendered as a link and landed on the capability-unavailable
   * screen with the contact they were reading now off-screen. The cell said
   * "Recorded — needs dialer access" instead.
   *
   * The destination is now the agency's own call detail, gated on `agency` and
   * floored at `agency.supervise` — which is what this page already requires. So
   * there is no such viewer, the branch is dead, and its removal is the fix
   * rather than a regression.
   */
  it('links without a calls.dialer capability, because the destination does not need one', async () => {
    mocks.isEnabled.mockImplementation((capability: string) => capability !== 'calls.dialer');
    renderPage();
    const row = await screen.findByTestId('contact-attempt-attempt-1');

    expect(within(row).getByText('Open call')).toBeTruthy();
    expect(within(row).queryByText('Recorded — needs dialer access')).toBeNull();
  });

  it('never points into the /app zone', async () => {
    renderPage();
    const row = await screen.findByTestId('contact-attempt-attempt-1');

    const href = within(row).getByText('Open call').closest('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/agency/')).toBe(true);
    expect(href).not.toContain('/app');
  });

  it('fails open — an unresolved governance map still offers the link', async () => {
    // Matches `RequireCapability`'s own posture: the server's 403 is the real
    // enforcement, so an empty map must not hide a working link.
    mocks.isEnabled.mockReturnValue(true);
    renderPage();
    const row = await screen.findByTestId('contact-attempt-attempt-1');
    expect(within(row).getByText('Open call')).toBeTruthy();
  });
});

describe('paging the history', () => {
  const SECOND_PAGE_ATTEMPT: AgencyAttempt = { ...ATTEMPT, id: 'attempt-99', attempt_number: 1 };

  beforeEach(() => {
    mocks.getCampaignAttempts.mockResolvedValue({
      rows: [ATTEMPT, ABANDONED], next_cursor: 'cursor-2', limit: 50,
    });
  });

  it('a failed "Load older attempts" keeps the contact and the loaded rows on screen', async () => {
    renderPage();
    const button = await screen.findByTestId('contact-attempts-more');
    mocks.getCampaignAttempts.mockRejectedValueOnce(new Error('upstream unavailable'));
    fireEvent.click(button);

    // The regression: this used to write into the page-level `error`, whose
    // render branch returns before the header — replacing a successfully loaded
    // contact with an error card because a SECOND request failed.
    expect(await screen.findByTestId('contact-attempts-more-error')).toBeTruthy();
    expect(screen.getByTestId('contact-summary')).toBeTruthy();
    expect(screen.getByTestId('contact-attempt-attempt-1')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('retrying after a failure appends rather than reloading the page', async () => {
    renderPage();
    const button = await screen.findByTestId('contact-attempts-more');
    mocks.getCampaignAttempts.mockRejectedValueOnce(new Error('upstream unavailable'));
    fireEvent.click(button);
    await screen.findByTestId('contact-attempts-more-error');

    mocks.getCampaignAttempts.mockResolvedValueOnce({
      rows: [SECOND_PAGE_ATTEMPT], next_cursor: null, limit: 50,
    });
    fireEvent.click(screen.getByTestId('contact-attempts-more'));

    expect(await screen.findByTestId('contact-attempt-attempt-99')).toBeTruthy();
    // The first page is still there — this appended, it did not reload.
    expect(screen.getByTestId('contact-attempt-attempt-1')).toBeTruthy();
    expect(screen.queryByTestId('contact-attempts-more-error')).toBeNull();
  });
});

describe('a response that arrives after the operator moved on', () => {
  /**
   * Nothing cancels these fetches, and React does not drop a `setState` from a
   * promise that resolves late. On most screens that is a flicker. Here every
   * write is a claim about WHICH NUMBER WAS CALLED, so a late response puts one
   * contact's history under another contact's phone number — on the one surface
   * built to answer "how many times did you call me", read by someone
   * answering a regulator.
   *
   * The route path is unchanged across the navigation (only `:contactId`
   * moves), so React Router reuses the element and the component instance —
   * which is precisely the case a per-mount flag would miss and the generation
   * counter has to cover.
   */
  const CONTACT_2: AgencyContactDetail = {
    ...CONTACT, id: 'contact-2', phone_e164: '+919876500002', csv_line_number: 13,
  };
  const ATTEMPT_2: AgencyAttempt = {
    ...ATTEMPT, id: 'attempt-c2', contact_id: 'contact-2', phone_e164: '+919876500002',
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  function renderWithNav() {
    function Nav() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          data-testid="go-contact-2"
          onClick={() => navigate('/agency/campaigns/camp-1/contacts/contact-2')}
        >
          go
        </button>
      );
    }
    return render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/contacts/contact-1']}>
        <Nav />
        <Routes>
          <Route path="/agency/campaigns/:id/contacts/:contactId" element={<ContactDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('does not let a slow first contact overwrite the one now on screen', async () => {
    const slow = deferred<AgencyContactDetail>();
    mocks.getCampaignContact
      .mockReturnValueOnce(slow.promise)       // contact-1, still in flight
      .mockResolvedValueOnce(CONTACT_2);       // contact-2, lands first
    mocks.getCampaignAttempts
      .mockResolvedValueOnce({ rows: [ATTEMPT], next_cursor: null, limit: 50 })
      .mockResolvedValueOnce({ rows: [ATTEMPT_2], next_cursor: null, limit: 50 });

    renderWithNav();
    fireEvent.click(screen.getByTestId('go-contact-2'));
    expect(await screen.findByRole('heading', { level: 1, name: '+919876500002' })).toBeTruthy();

    // contact-1's request finally answers, addressed to a screen nobody is on.
    slow.resolve(CONTACT);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByRole('heading', { level: 1, name: '+919876500002' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: '+919876500001' })).toBeNull();
    expect(screen.getByTestId('contact-attempt-attempt-c2')).toBeTruthy();
    expect(screen.queryByTestId('contact-attempt-attempt-1')).toBeNull();
  });

  it('does not append the previous contact\u2019s older attempts onto this one', async () => {
    mocks.getCampaignContact
      .mockResolvedValueOnce(CONTACT)
      .mockResolvedValueOnce(CONTACT_2);
    const slowPage = deferred<{ rows: AgencyAttempt[]; next_cursor: string | null; limit: number }>();
    mocks.getCampaignAttempts
      .mockResolvedValueOnce({ rows: [ATTEMPT], next_cursor: 'cursor-2', limit: 50 })
      .mockReturnValueOnce(slowPage.promise)   // contact-1's "load more", in flight
      .mockResolvedValueOnce({ rows: [ATTEMPT_2], next_cursor: null, limit: 50 });

    renderWithNav();
    fireEvent.click(await screen.findByTestId('contact-attempts-more'));
    fireEvent.click(screen.getByTestId('go-contact-2'));
    expect(await screen.findByRole('heading', { level: 1, name: '+919876500002' })).toBeTruthy();

    // The older page for contact-1 lands now. Appending it here would put one
    // person's call history inside another's.
    slowPage.resolve({
      rows: [{ ...ATTEMPT, id: 'attempt-old', attempt_number: 1 }],
      next_cursor: null,
      limit: 50,
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByTestId('contact-attempt-attempt-old')).toBeNull();
    expect(screen.getByTestId('contact-attempt-attempt-c2')).toBeTruthy();
  });
});
