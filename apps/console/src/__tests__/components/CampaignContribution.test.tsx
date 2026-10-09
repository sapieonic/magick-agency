import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { campaignTotalRow, contributionPage } from '../helpers/contribution';

/**
 * The contribution view's wiring — what it asks for, and what it says about the
 * answer.
 *
 * ── The two reads are the subject of this file ─────────────────────────────
 * One grouped by `agent,campaign` for the rows and one by `campaign` for the
 * campaign's own line, because the second is NOT the sum of the first: master drops
 * departed members from an agent-grouped page and has nothing to drop from a
 * campaign-grouped one. Several cases below exist only to pin that the two are
 * asked separately, that `include_inactive` reaches exactly one of them, and that
 * the difference between them is stated in words rather than left on screen as
 * arithmetic that does not work out.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  trackViewed: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
// Analytics is a safe no-op in tests, but stub it so intent can be asserted.
vi.mock('../../analytics/events', () => ({
  trackAgencyCampaignContributionViewed: mocks.trackViewed,
}));
/*
  Mocked at the API boundary, the seam every other agency test mocks at — master's
  grouped route is being written in parallel and does not exist to call.
*/
vi.mock('../../api/agencyStats', () => ({
  getAgencyGroupedStats: mocks.getAgencyGroupedStats,
}));

import { CampaignContribution } from '../../components/agency/CampaignContribution';

function tenant(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
    ...over,
  };
}

const NAMES = new Map<string, string | null>([['camp-1', 'Renewals']]);

function renderView(over: Partial<Parameters<typeof CampaignContribution>[0]> = {}) {
  const onBack = vi.fn();
  const onCampaignChange = vi.fn();
  const onSelectAgent = vi.fn();
  const view = render(
    <CampaignContribution
      campaignId="camp-1"
      campaignNames={NAMES}
      period="week"
      includeInactive={false}
      onCampaignChange={onCampaignChange}
      onSelectAgent={onSelectAgent}
      onBack={onBack}
      {...over}
    />,
  );
  /*
    `campaignId` is a CONTROLLED prop, so a case about what changing it re-reads has
    to re-render with the new value the way the caller would. Returned rather than
    re-`render`ed inside the case, so the component is not remounted — the whole
    point of the control is that the window and the toggle survive it.
  */
  const setCampaign = (campaignId: string) =>
    view.rerender(
      <CampaignContribution
        campaignId={campaignId}
        campaignNames={NAMES}
        period="week"
        includeInactive={false}
        onCampaignChange={onCampaignChange}
        onSelectAgent={onSelectAgent}
        onBack={onBack}
        {...over}
      />,
    );
  return { onBack, onCampaignChange, onSelectAgent, setCampaign };
}

/**
 * The default double: the rows read answers with the page, the campaign-grouped
 * read with one row.
 *
 * Keyed off `group_by` rather than call order, because the two are fired
 * concurrently and asserting on order would pin a coincidence.
 */
function answerBoth(
  page = contributionPage(),
  total: ReturnType<typeof campaignTotalRow> | null = campaignTotalRow(),
) {
  mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) => {
    if (query.group_by.includes('agent')) return Promise.resolve(page);
    return Promise.resolve(
      contributionPage({
        group_by: ['campaign'],
        limit: 1,
        rows: total === null ? [] : [total as never],
        total_groups: total === null ? 0 : 1,
      }),
    );
  });
}

/*
  The LATEST of each, not the first: a control that refetches fires a second pair,
  and asserting on the first would pin the request the reader has already replaced.
*/
type SentQuery = { group_by: readonly string[]; from: string; to: string };

function rowsQuery(): SentQuery {
  return mocks.getAgencyGroupedStats.mock.calls
    .map((call) => call[0] as SentQuery)
    .filter((query) => query.group_by.includes('agent'))
    .at(-1)!;
}

function totalQuery(): SentQuery {
  return mocks.getAgencyGroupedStats.mock.calls
    .map((call) => call[0] as SentQuery)
    .filter((query) => !query.group_by.includes('agent'))
    .at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  answerBoth();
});

afterEach(() => cleanup());

describe('CampaignContribution — the two reads', () => {
  it('asks for the agent rows AND the campaign’s own line, once each', async () => {
    renderView();
    await screen.findByTestId('contribution-table');

    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2);
    expect(rowsQuery()).toMatchObject({
      campaign_id: 'camp-1',
      group_by: ['agent', 'campaign'],
      sort: 'successes',
      order: 'desc',
      limit: 200,
    });
    expect(totalQuery()).toMatchObject({
      campaign_id: 'camp-1',
      group_by: ['campaign'],
      // One campaign filtered and grouped by campaign: one row exists at most.
      limit: 1,
    });
  });

  it('sends the tenant and the account on both, and no agent id on either', async () => {
    /**
     * The account is a REQUIRED predicate on this route rather than a filter —
     * master answers `400 account_scope_required` before it even resolves the
     * tenant's core key. And `agent_user_id` is not an accepted filter on either
     * service: core has no user table, so only master's memberships can police that
     * boundary, and naming one person is the per-agent record's job.
     */
    renderView();
    await screen.findByTestId('contribution-table');

    for (const call of mocks.getAgencyGroupedStats.mock.calls) {
      expect(call[1]).toBe('tenant-1');
      expect(call[2]).toBe('account-1');
      expect(call[0]).not.toHaveProperty('agent_user_id');
    }
  });

  it('asks nothing at all until the account has resolved', () => {
    /**
     * Every agency read waits for both ids: a request sent while `TenantContext` is
     * still resolving carries no `X-Account-Id`, which the server answers with a
     * 400 about a header this client never sent. The caller's own guard is what
     * stops the spinner being permanent.
     */
    mocks.useTenant.mockReturnValue(tenant({ accountId: null }));
    renderView();
    expect(mocks.getAgencyGroupedStats).not.toHaveBeenCalled();
  });

  it('sends the same window to both reads', async () => {
    // One `now` for both, so the rows and the campaign line describe the same
    // window to the millisecond — otherwise the note comparing them compares two
    // moments.
    renderView();
    await screen.findByTestId('contribution-table');
    expect(rowsQuery()).toMatchObject({ from: totalQuery().from, to: totalQuery().to });
  });

  it('asks for a CLOSED range when a completed window is chosen', async () => {
    /**
     * `last_week` is `[startOfWeek(now - 7d), startOfWeek(now))`. A weekly review is
     * run on a Monday morning, when "this week" is ninety minutes of dials.
     */
    renderView();
    await screen.findByTestId('contribution-table');
    mocks.getAgencyGroupedStats.mockClear();

    fireEvent.change(screen.getByTestId('contribution-period'), {
      target: { value: 'last_week' },
    });

    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2));
    const query = rowsQuery();
    expect(new Date(query.to).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('CampaignContribution — include_inactive reaches the rows only', () => {
  it('omits it entirely when former members are hidden', async () => {
    // Master accepts only `true|false|1|0` and 400s otherwise; an explicit `false`
    // is one more thing for the whitelist to agree about for no gain.
    renderView();
    await screen.findByTestId('contribution-table');
    expect(rowsQuery()).not.toHaveProperty('include_inactive');
  });

  it('never sends it on the campaign line, in either state', async () => {
    /**
     * It is meaningless there — nothing is dropped from a row that belongs to no
     * person — and because it is not sent, the campaign line cannot MOVE when the
     * reader toggles it. That is the same property the roster's benchmark has, and
     * for the same reason: a figure that moved under a row filter would be a
     * different number under the same name.
     */
    renderView({ includeInactive: true });
    await screen.findByTestId('contribution-table');

    expect(rowsQuery()).toMatchObject({ include_inactive: true });
    expect(totalQuery()).not.toHaveProperty('include_inactive');
  });

  it('re-reads the rows when the toggle is used, and leaves the total where it was', async () => {
    answerBoth(contributionPage({ inactive_omitted: 2 }));
    renderView();
    await screen.findByTestId('contribution-table');
    const before = screen.getByTestId('contribution-total-row').textContent;

    fireEvent.click(screen.getByTestId('contribution-include-inactive'));

    await waitFor(() => expect(rowsQuery()).toMatchObject({ include_inactive: true }));
    await screen.findByTestId('contribution-table');
    expect(screen.getByTestId('contribution-total-row').textContent).toBe(before);
  });

  it('inherits the roster’s toggle rather than resetting it', async () => {
    // Arriving here must not silently change what the reader was looking at — the
    // same reasoning the per-agent drill-down carries about its window.
    renderView({ includeInactive: true });
    await screen.findByTestId('contribution-table');
    expect((screen.getByTestId('contribution-include-inactive') as HTMLInputElement).checked).toBe(
      true,
    );
  });
});

describe('CampaignContribution — the D8 asymmetry is on the screen', () => {
  it('states the gap ABOVE the table when rows were dropped', async () => {
    /**
     * ⚠️ The trap this screen exists to not fall into. The campaign line counts
     * everyone who dialled it; the agent rows exclude the people who have since
     * left. So the rows do not add up to the line, and the difference is exactly
     * those members' work — which is fine, and unreadable unless it is said.
     *
     * Above the table because it is about how to read what IS on screen: a caveat
     * met after the reader has already added the column up is not a caveat.
     */
    answerBoth(contributionPage({ inactive_omitted: 2 }));
    renderView();

    const note = await screen.findByTestId('contribution-asymmetry');
    expect(note.textContent).toContain('2 former team members');
    expect(note.textContent).toContain('do not add up');
    expect(note.textContent).toContain('Show former team members');

    // And the total is NOT hidden to make the arithmetic tidy: both figures stay on
    // screen with the sentence between them.
    expect(within(screen.getByTestId('contribution-total-row')).getByText('80')).toBeTruthy();
    expect(within(screen.getByTestId('contribution-row-user-1')).getByText('30%')).toBeTruthy();
  });

  it('says nothing when nothing was dropped', async () => {
    renderView();
    await screen.findByTestId('contribution-table');
    expect(screen.queryByTestId('contribution-asymmetry')).toBeNull();
  });

  it('offers the toggle as soon as there is something hidden', async () => {
    // The note names it as the remedy, so the two appear together or the sentence
    // sends the reader looking for a control that is not there.
    answerBoth(contributionPage({ inactive_omitted: 1 }));
    renderView();
    await screen.findByTestId('contribution-asymmetry');
    expect(screen.getByTestId('contribution-include-inactive')).toBeTruthy();
  });

  it('puts that remedy BENEATH the sentence, not at the foot of the page', async () => {
    /**
     * It used to be the last element on the page, below a 200-row table. A sentence
     * whose final clause is "tick the box" is a sentence whose remedy has to be
     * reachable from where it is read — otherwise the reader scrolls past the table
     * looking for a control the note implied was nearby.
     */
    answerBoth(contributionPage({ inactive_omitted: 2 }));
    renderView();

    const note = await screen.findByTestId('contribution-asymmetry');
    const toggle = screen.getByTestId('contribution-include-inactive');
    const table = screen.getByTestId('contribution-table');

    // `2` is `Node.DOCUMENT_POSITION_PRECEDING`: the toggle comes before the table,
    // and after the sentence that names it.
    expect(table.compareDocumentPosition(toggle) & 2).toBeTruthy();
    expect(note.compareDocumentPosition(toggle) & 4).toBeTruthy();
  });
});

describe('CampaignContribution — the four states', () => {
  it('shows a spinner while both reads are in flight', () => {
    mocks.getAgencyGroupedStats.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByTestId('contribution-loading')).toBeTruthy();
  });

  it('offers a retry on a failed rows read, and re-asks', async () => {
    /**
     * The rows are what the reader came for, so their failure is the screen's
     * failure — and "we could not ask" is a different fact from "nobody dialled
     * it", which is why an empty table for both would be wrong.
     */
    // A message `ErrorAlert` passes through verbatim — it rewrites the ones it can
    // make friendlier ("Forbidden", "500"), which would make this assertion about
    // that component's copy rather than about the server's sentence reaching it.
    mocks.getAgencyGroupedStats.mockRejectedValue(new Error('Request Failed'));
    renderView();

    await screen.findByTestId('contribution-error');
    expect(screen.getByText('Request Failed')).toBeTruthy();
    mocks.getAgencyGroupedStats.mockClear();
    answerBoth();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('contribution-table');
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2);
  });

  it('degrades when only the campaign line fails, rather than failing the screen', async () => {
    /**
     * The rows are still worth reading without their denominator. So the table
     * renders, the footer says the line could not be read, the Share column says
     * what it is missing, and a sentence below the table says it once more — because
     * a missing denominator changes how the whole column reads.
     */
    mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) =>
      query.group_by.includes('agent')
        ? Promise.resolve(contributionPage())
        : Promise.reject(new Error('nope')),
    );
    renderView();

    await screen.findByTestId('contribution-table');
    expect(screen.getByTestId('contribution-total-failed')).toBeTruthy();
    expect(screen.getByTestId('contribution-total-missing')).toBeTruthy();
    expect(screen.queryByTestId('contribution-error')).toBeNull();
  });

  it('says nobody dialled it when nothing came back and nothing was hidden', async () => {
    answerBoth(contributionPage({ rows: [], total_groups: 0 }), null);
    renderView();

    const empty = await screen.findByTestId('contribution-empty');
    expect(empty.textContent).toContain('Renewals');
    expect(screen.queryByTestId('contribution-table')).toBeNull();
  });

  it('distinguishes "everyone who dialled it has left" from "nobody dialled it"', async () => {
    /**
     * An ordinary master response — core returns two revoked agents, master filters
     * both — and a different screen: the remedy is the checkbox, not a longer
     * window, so the sentence advising a longer window must not be the one that
     * renders.
     */
    answerBoth(contributionPage({ rows: [], total_groups: 2, inactive_omitted: 2 }));
    renderView();

    const note = await screen.findByTestId('contribution-all-departed');
    expect(note.textContent).toContain('Show former team members');
    expect(screen.queryByTestId('contribution-empty')).toBeNull();
    expect(screen.getByTestId('contribution-include-inactive')).toBeTruthy();
    /*
      And ONE sentence, not two. The asymmetry note is about "the rows below" and
      there are none: it used to render "the rows below do not add up to it"
      directly above the paragraph explaining that every row was hidden, with the
      same remedy named twice.
    */
    expect(screen.queryByTestId('contribution-asymmetry')).toBeNull();
  });

  it('refuses a body whose rows are not an array rather than crashing the render', async () => {
    // `.map` of `undefined` during render takes the section down with no error
    // boundary above it — the one absence on this surface the reader cannot act on.
    mocks.getAgencyGroupedStats.mockResolvedValue({ rows: undefined } as never);
    renderView();
    await screen.findByTestId('contribution-error');
  });

  it('treats a MALFORMED campaign line as a failure, not as "no total"', async () => {
    /**
     * ⚠️ `totalFailed` was `outcome.status === 'rejected'` alone, so a fulfilled
     * response this page cannot read — no body, or `rows` not an array — produced
     * `total: null` with `totalFailed: false`. The footer then said "no total to
     * divide by", which is the sentence for a campaign that had no dials in the
     * window: an ANSWER, and one a reader acts on by widening the window. The truth
     * was that the read came back unusable and should be retried. A degrade path
     * reporting a failure as a successful nothing is the same class of defect as a 200
     * claiming nothing was hidden.
     */
    mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) =>
      query.group_by.includes('agent')
        ? Promise.resolve(contributionPage())
        : Promise.resolve({ rows: undefined } as never),
    );
    renderView();

    await screen.findByTestId('contribution-table');
    expect(screen.getByTestId('contribution-total-failed')).toBeTruthy();
    // And the ROWS still render: only the denominator was lost.
    expect(screen.queryByTestId('contribution-error')).toBeNull();
  });

  it('keeps a well-formed EMPTY campaign line an answer rather than a failure', async () => {
    /**
     * The one case the fix above must not reclassify. A campaign with no dials in the
     * window has no group to return, so `rows: []` is the server correctly saying
     * "nothing here" — which is why the array check is separate from the emptiness of
     * it.
     */
    answerBoth(contributionPage(), null);
    renderView();

    await screen.findByTestId('contribution-table');
    expect(screen.queryByTestId('contribution-total-failed')).toBeNull();
    expect(screen.getByTestId('contribution-total-missing')).toBeTruthy();
  });

  it('offers a REAL retry on the failed campaign line, and re-reads both', async () => {
    /**
     * ⚠️ The paragraph described itself as retryable — "a failure with a retry, not an
     * absence to live with" — and offered nothing: the only Retry on the surface lived
     * in the rows-error branch, which by construction is not the branch being
     * rendered. So the one recoverable failure on the screen was the one with no way
     * to recover from it.
     *
     * Both reads fire again, which is correct rather than wasteful: the Share column
     * divides one by the other, so re-reading only the total would pair a fresh
     * campaign line with rows from an older moment.
     */
    mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) =>
      query.group_by.includes('agent')
        ? Promise.resolve(contributionPage())
        : Promise.reject(new Error('nope')),
    );
    renderView();
    await screen.findByTestId('contribution-total-failed');

    mocks.getAgencyGroupedStats.mockClear();
    answerBoth();
    fireEvent.click(screen.getByTestId('contribution-total-retry'));

    await waitFor(() =>
      expect(screen.queryByTestId('contribution-total-failed')).toBeNull(),
    );
    // The SECOND pair, both of them — asserted as a pair because one alone would put
    // the two figures a beat apart.
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2);
    expect(rowsQuery()).toMatchObject({ group_by: ['agent', 'campaign'] });
    expect(totalQuery()).toMatchObject({ group_by: ['campaign'], limit: 1 });
    expect(screen.getByTestId('contribution-table')).toBeTruthy();
  });

  it('does NOT say everyone left when the rows were UNATTRIBUTED', async () => {
    /**
     * ⚠️ The roster's bug on this screen, and sharper here: `empty` keyed on
     * `inactive_omitted` alone, so `{ rows: [], unattributed_omitted: 3 }` — groups
     * master could not attribute to any member, R4's third state — took the empty arm
     * and said "Nobody was handed a call on Renewals in this window". Meanwhile the
     * campaign's own line is pinned in the footer and still counts their calls, so the
     * reader is told the whole team resigned while looking at the work they did.
     *
     * The toggle cannot bring these rows back either: `include_inactive` widens a
     * membership filter and they match no membership of any status.
     */
    answerBoth(
      contributionPage({ rows: [], total_groups: 3, inactive_omitted: 0, unattributed_omitted: 3 }),
    );
    renderView();

    const note = await screen.findByTestId('contribution-all-unattributed');
    expect(screen.queryByTestId('contribution-empty')).toBeNull();
    expect(screen.queryByTestId('contribution-all-departed')).toBeNull();
    expect(note.textContent).toContain('Renewals');
    expect(note.textContent).toContain('will not reveal them');
    expect(screen.queryByTestId('contribution-table')).toBeNull();
  });

  it('names both causes when both kinds of row were dropped', async () => {
    answerBoth(
      contributionPage({ rows: [], total_groups: 4, inactive_omitted: 2, unattributed_omitted: 2 }),
    );
    renderView();

    const note = await screen.findByTestId('contribution-all-hidden');
    expect(note.textContent).toContain('left the team');
    expect(note.textContent).toContain('could not be matched');
    expect(screen.queryByTestId('contribution-empty')).toBeNull();
    expect(screen.queryByTestId('contribution-all-departed')).toBeNull();
  });
});

describe('CampaignContribution — what it says about itself', () => {
  it('names the campaign in the heading, the caption and the back button’s destination', async () => {
    renderView();
    await screen.findByTestId('contribution-table');

    expect(screen.getByRole('heading', { name: 'Who drove Renewals' })).toBeTruthy();
    expect(screen.getByText(/Who drove Renewals — this week, ranked by conversions/)).toBeTruthy();
  });

  it('captions the order the server echoed, and never "ranked by undefined"', async () => {
    // The echo, with the wire value as the last resort — the same fallback the
    // truncation note carries. An order this build's vocabulary does not know is a
    // version skew, and a caption is the last place to print the word `undefined`.
    answerBoth(contributionPage({ sort: 'connect_rate_pct' }));
    renderView();
    await screen.findByTestId('contribution-table');
    expect(screen.getByText(/ranked by connect rate/)).toBeTruthy();

    cleanup();
    answerBoth(contributionPage({ sort: 'something_new' as never }));
    renderView();
    await screen.findByTestId('contribution-table');
    expect(screen.getByText(/ranked by something_new/)).toBeTruthy();
  });

  it('falls back to a shortened id for a campaign it cannot name', async () => {
    // An id with no match renders as an id — never blank, and never a name this
    // client invented for a campaign the server declined to identify.
    renderView({ campaignId: 'camp-unknown-9', campaignNames: new Map() });
    await screen.findByTestId('contribution-table');
    expect(screen.getByRole('heading', { name: 'Who drove Campaign camp-unk' })).toBeTruthy();
  });

  it('reads out the population that dialled the campaign', async () => {
    answerBoth(contributionPage({ total_groups: 6 }));
    renderView();
    expect((await screen.findByTestId('contribution-count')).textContent).toBe(
      '6 agents dialled this campaign',
    );
  });

  it('goes back to the roster without touching history', async () => {
    const { onBack } = renderView();
    await screen.findByTestId('contribution-table');
    fireEvent.click(screen.getByTestId('contribution-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('names its own window control, and starts on the roster’s window', async () => {
    renderView({ period: 'last_month' });
    await screen.findByTestId('contribution-table');

    expect(screen.getByLabelText('Window')).toBe(screen.getByTestId('contribution-period'));
    expect((screen.getByTestId('contribution-period') as HTMLSelectElement).value).toBe(
      'last_month',
    );
  });

  it('names the DAYS the figures cover, and the zone they were cut in', async () => {
    /**
     * "This week" names the control, not a range — and on a Monday morning it means
     * something different every hour. This is the screen whose conversion rates get
     * quoted in a pay conversation or disputed by a dealer, so the days are on it.
     *
     * Read off the ECHO (`page.from` / `page.to`), like every other sentence here,
     * and the last day shown is the one before the EXCLUSIVE bound — a window ending
     * at midnight on the 26th covers up to the 25th. The zone is the reader's and is
     * named, so two people in two offices can see why their numbers differ.
     */
    answerBoth(
      contributionPage({
        from: '2026-08-24T00:00:00.000Z',
        to: '2026-08-26T00:00:00.000Z',
      }),
    );
    renderView();

    expect((await screen.findByTestId('contribution-window-range')).textContent).toBe(
      '24 Aug – 25 Aug 2026 · UTC',
    );
  });

  it('says the page was cut, and by which order', async () => {
    answerBoth(contributionPage({ total_groups: 240, limit: 200 }));
    renderView();
    expect((await screen.findByTestId('contribution-truncated')).textContent).toBe(
      'Showing the top 200 by conversions — the rest are further down that order.',
    );
  });
});

describe('CampaignContribution — the campaign is a control, not a visit', () => {
  /**
   * A supervisor reviewing four dealerships was leaving and re-entering this screen
   * four times, re-choosing the window each time. The premise of the view is one
   * campaign AT A TIME — not one campaign per visit.
   */
  const FOUR = new Map<string, string | null>([
    ['camp-1', 'Renewals'],
    ['camp-2', 'Winback'],
    ['camp-3', 'Aftermarket'],
    ['camp-unnamed', null],
  ]);

  it('offers the campaigns it can name, alphabetically, and no "all" option', async () => {
    /**
     * No pooled option, unlike the roster's filter: a share of every campaign in the
     * account is not a contribution, and the Share column's denominator is one
     * campaign's own line. Sorted by name, the roster's own rule, so the two
     * controls offer the same set in the same order.
     */
    renderView({ campaignNames: FOUR });
    await screen.findByTestId('contribution-table');

    const select = screen.getByTestId('contribution-campaign') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Aftermarket',
      'Renewals',
      'Winback',
    ]);
    expect(select.value).toBe('camp-1');
    expect(screen.getByLabelText('Campaign')).toBe(select);
  });

  it('keeps a campaign it cannot name in the list, as an id', async () => {
    // A `<select>` whose value matches no option renders BLANK — on the control that
    // says which campaign every figure on the page is about. So it is present and
    // marked as an id, through the same stand-in the heading uses.
    renderView({ campaignId: 'camp-unnamed', campaignNames: FOUR });
    await screen.findByTestId('contribution-table');

    const select = screen.getByTestId('contribution-campaign') as HTMLSelectElement;
    expect(select.value).toBe('camp-unnamed');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Campaign camp-unn',
      'Aftermarket',
      'Renewals',
      'Winback',
    ]);
  });

  it('reports the change upwards rather than re-scoping itself', async () => {
    /**
     * The campaign is a controlled prop. The caller owns it because it also owns the
     * ROSTER's campaign filter, and the two must not be one: going back has to land
     * on the roster the reader left, not on one this screen re-scoped behind them.
     */
    const { onCampaignChange } = renderView({ campaignNames: FOUR });
    await screen.findByTestId('contribution-table');

    fireEvent.change(screen.getByTestId('contribution-campaign'), {
      target: { value: 'camp-2' },
    });

    expect(onCampaignChange).toHaveBeenCalledWith('camp-2');
  });

  it('re-reads BOTH lines for the new campaign, and keeps the window and the toggle', async () => {
    /**
     * ⚠️ The property the control exists for: four campaigns over ONE range. A view
     * that reset its window per campaign would make the comparison impossible, which
     * is why the caller must not `key` this component by the campaign.
     */
    answerBoth(contributionPage({ inactive_omitted: 2 }));
    const { setCampaign } = renderView({ period: 'last_week', campaignNames: FOUR });
    await screen.findByTestId('contribution-table');

    fireEvent.click(screen.getByTestId('contribution-include-inactive'));
    await waitFor(() => expect(rowsQuery()).toMatchObject({ include_inactive: true }));
    mocks.getAgencyGroupedStats.mockClear();

    setCampaign('camp-2');

    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2));
    expect(rowsQuery()).toMatchObject({ campaign_id: 'camp-2', include_inactive: true });
    expect(totalQuery()).toMatchObject({ campaign_id: 'camp-2' });
    // Neither control moved.
    expect((screen.getByTestId('contribution-period') as HTMLSelectElement).value).toBe(
      'last_week',
    );
    expect((screen.getByTestId('contribution-include-inactive') as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('renames the heading and the caption for the campaign now in scope', async () => {
    const { setCampaign } = renderView({ campaignNames: FOUR });
    await screen.findByTestId('contribution-table');

    setCampaign('camp-2');

    expect(await screen.findByRole('heading', { name: 'Who drove Winback' })).toBeTruthy();
    expect(screen.getByText(/Who drove Winback — this week/)).toBeTruthy();
  });
});

describe('CampaignContribution — a row opens that person', () => {
  it('hands the caller the id and the name, and mounts nothing itself', async () => {
    /**
     * The panels replace this screen the way this screen replaces the roster, so
     * exactly one read is ever in flight — which means this component reports who
     * was pressed and does not mount them.
     */
    const { onSelectAgent } = renderView();
    await screen.findByTestId('contribution-table');

    fireEvent.click(screen.getByTestId('contribution-open-user-1'));

    expect(onSelectAgent).toHaveBeenCalledWith({
      agent_user_id: 'user-1',
      agent_name: 'Ravi Kumar',
    });
    // Still the contribution table: this component does not swap itself out.
    expect(screen.getByTestId('contribution-table')).toBeTruthy();
  });
});

describe('CampaignContribution — what it reports about itself', () => {
  it('fires one view event, with the page’s honesty state on it', async () => {
    /**
     * The fields are the ones a question about this screen will be about: whether
     * the campaign's own line — the Share column's denominator — was readable at
     * all, whether master hid rows, and whether `limit` cut the page. `truncated` is
     * the console's own answer rather than three counts for a funnel to re-derive.
     */
    answerBoth(
      contributionPage({
        total_groups: 240,
        limit: 200,
        inactive_omitted: 2,
        unattributed_omitted: 1,
      }),
    );
    renderView({ period: 'last_week' });
    await screen.findByTestId('contribution-table');

    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));
    expect(mocks.trackViewed).toHaveBeenCalledWith({
      campaign_id: 'camp-1',
      window: 'last_week',
      rows: 1,
      total_groups: 240,
      total_read: true,
      inactive_omitted: 2,
      unattributed_omitted: 1,
      include_inactive: false,
      truncated: true,
    });
  });

  it('says the campaign line was unreadable rather than omitting the fact', async () => {
    mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) =>
      query.group_by.includes('agent')
        ? Promise.resolve(contributionPage())
        : Promise.reject(new Error('nope')),
    );
    renderView();
    await screen.findByTestId('contribution-table');

    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));
    expect(mocks.trackViewed.mock.calls[0]![0]).toMatchObject({
      total_read: false,
      // Absent counts are 0 on the event too, never `undefined` — a property that is
      // sometimes missing is a property nothing can be filtered on.
      unattributed_omitted: 0,
    });
  });

  it('does not fire again when only the window moves', async () => {
    // One event per campaign opened, not per control touched — otherwise "how often
    // is this screen opened" counts how often a `<select>` was used.
    renderView();
    await screen.findByTestId('contribution-table');
    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('contribution-period'), {
      target: { value: 'last_week' },
    });
    await waitFor(() => expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(4));
    await screen.findByTestId('contribution-table');

    expect(mocks.trackViewed).toHaveBeenCalledTimes(1);
  });

  it('fires again for a DIFFERENT campaign, which is a different view', async () => {
    /**
     * The guard keys on the campaign rather than on the mount, because the selector
     * re-reads without remounting — a bare "once per mount" ref would report the
     * first campaign of a four-campaign review and none of the others.
     */
    const { setCampaign } = renderView({
      campaignNames: new Map<string, string | null>([
        ['camp-1', 'Renewals'],
        ['camp-2', 'Winback'],
      ]),
    });
    await screen.findByTestId('contribution-table');
    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(1));

    setCampaign('camp-2');

    await waitFor(() => expect(mocks.trackViewed).toHaveBeenCalledTimes(2));
    expect(mocks.trackViewed.mock.calls[1]![0]).toMatchObject({ campaign_id: 'camp-2' });
  });
});
