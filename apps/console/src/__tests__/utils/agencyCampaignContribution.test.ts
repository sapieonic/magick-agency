import { describe, it, expect } from 'vitest';
import {
  CONTRIBUTION_COLUMNS,
  CONTRIBUTION_GROUP_BY,
  CONTRIBUTION_SORT,
  CONTRIBUTION_SORT_LABELS,
  CONTRIBUTION_TOTAL_GROUP_BY,
  contributionAgentName,
  contributionAriaSort,
  contributionAsymmetryNote,
  contributionConnectRateCell,
  contributionConversionCell,
  contributionCountReadout,
  contributionHandleTimeCell,
  contributionNameResolved,
  contributionRatesReportable,
  contributionRowKey,
  contributionShareCell,
  contributionSuccessRateReportable,
  contributionTruncationNote,
} from '../../utils/agencyCampaignContribution';
import {
  campaignTotalRow,
  contributionPage,
  contributionRow,
  hollowContributionRow,
  thinContributionRow,
} from '../helpers/contribution';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyGroupPage,
  type AgencyGroupRowWithName,
} from '../../types/agency-stats';

/**
 * The contribution view's derivations.
 *
 * ── The one rule this file exists for ─────────────────────────────────────
 * The screen puts a campaign's own total next to per-agent rows that the API may
 * have filtered, so **the two do not have to add up** — and the difference is
 * exactly the work of people who have left the team. Every case about
 * `contributionAsymmetryNote` and `contributionShareCell` is about that: the rows
 * are not normalised to 100%, the total is not hidden to make the arithmetic
 * tidy, and the sentence naming the gap is present exactly when there is a gap.
 */

describe('agencyCampaignContribution — what the view asks for', () => {
  it('groups by agent AND campaign, and reads the campaign total separately', () => {
    /**
     * Two reads, and the second is not a sum of the first. With `agent` grouped
     * the API drops departed members' rows; with `campaign` alone there is nothing
     * to drop, because no row belongs to a person. Summing the rows instead would
     * silently redefine "the campaign's total" as "the total of the people still
     * here".
     */
    expect(CONTRIBUTION_GROUP_BY).toEqual(['agent', 'campaign']);
    expect(CONTRIBUTION_TOTAL_GROUP_BY).toEqual(['campaign']);
  });

  it('speaks the roster’s vocabulary for the same two quantities', () => {
    // `connects` for an answered call, `conversions` for a booked outcome. On a
    // dealership campaign the two are roughly a fivefold difference, and a second
    // word for either is that error on the number the dealer pays for.
    expect(CONTRIBUTION_SORT_LABELS.connected).toBe('connects');
    expect(CONTRIBUTION_SORT_LABELS.successes).toBe('conversions');
    expect(Object.values(CONTRIBUTION_SORT_LABELS)).not.toContain('conversations');
  });

  it('puts every rate’s own denominator in the column beside it', () => {
    /**
     * A count sits immediately left of the rate built from it, both times. The
     * server withholds a rate too thin to quote, but the pairing is what makes the
     * ones that ARE quoted readable against the denominator they came from.
     */
    const labels = CONTRIBUTION_COLUMNS.map((column) => column.label);
    expect(labels.indexOf('Dials')).toBe(labels.indexOf('Connect rate') - 4);
    expect(labels.indexOf('Conversions')).toBe(labels.indexOf('Conversion rate') - 3);
  });

  it('declares the WIRE sort on every column a sort can produce, and on no other', () => {
    /**
     * `aria-sort` is derived by comparing this declaration against the server's
     * echoed `sort` (see `contributionAriaSort`), which is why it is the wire value
     * rather than a `ranked: true` flag on the one column this view asks for. With
     * the flag, a server that defaulted or clamped the order announced Conversions
     * while the caption beside it — which already read the echo — said something
     * else.
     *
     * So every column showing a figure the wire can sort by declares it, and the
     * derived ones declare nothing: Agent has no wire sort (`key` orders by the
     * grouped key, which is not this column), and Share is computed here from a row
     * and the campaign's own line, so no server order produces it.
     */
    const declared = new Map(
      CONTRIBUTION_COLUMNS.filter((column) => column.sort !== undefined).map((column) => [
        column.label,
        column.sort,
      ]),
    );

    expect(declared.get('Dials')).toBe('attempts');
    expect(declared.get('Connects')).toBe('connected');
    expect(declared.get('Conversions')).toBe('successes');
    expect(declared.get('Connect rate')).toBe('connect_rate_pct');
    expect(declared.get('Conversion rate')).toBe('success_rate_pct');
    expect(declared.get('AHT')).toBe('aht_seconds');
    expect(declared.has('Agent')).toBe(false);
    expect(declared.has('Share')).toBe(false);

    // Every declaration is a value the wire vocabulary actually has — the label
    // table is keyed by that vocabulary, so a typo would be a column announcing an
    // order the caption cannot name.
    for (const sort of declared.values()) {
      expect(CONTRIBUTION_SORT_LABELS[sort!]).toBeTruthy();
    }
    // And exactly one column shows the order this view asks for.
    const ranked = [...declared.entries()].filter(([, sort]) => sort === CONTRIBUTION_SORT);
    expect(ranked.map(([label]) => label)).toEqual(['Conversions']);
  });

  it('announces the order the SERVER echoed, on the column that shows it', () => {
    /**
     * The echo, not the request. Both halves matter: a column the echo names carries
     * a real direction, and a column it does not name carries nothing at all —
     * `aria-sort="none"` on the other seven would announce seven orders nobody can
     * choose, because these headers are not pressable.
     */
    const page = contributionPage();
    const column = (label: string) => CONTRIBUTION_COLUMNS.find((c) => c.label === label)!;

    expect(contributionAriaSort(column('Conversions'), page)).toBe('descending');
    expect(contributionAriaSort(column('Connect rate'), page)).toBeUndefined();
    expect(contributionAriaSort(column('Agent'), page)).toBeUndefined();
    expect(contributionAriaSort(column('Share'), page)).toBeUndefined();

    // A server that clamped or defaulted the order announces it where the reader can
    // see it. Ascending is a real direction and is rendered as one.
    const clamped = contributionPage({ sort: 'attempts', order: 'asc' });
    expect(contributionAriaSort(column('Dials'), clamped)).toBe('ascending');
    expect(contributionAriaSort(column('Conversions'), clamped)).toBeUndefined();

    // `key` is the route's own default and no column shows it, so nothing is
    // announced rather than the nearest column claiming it.
    const keyOrdered = contributionPage({ sort: 'key', order: 'asc' });
    for (const c of CONTRIBUTION_COLUMNS) {
      expect(contributionAriaSort(c, keyOrdered)).toBeUndefined();
    }
  });
});

describe('agencyCampaignContribution — the share of the campaign', () => {
  it('divides by the CAMPAIGN’s total, not by the sum of the rows', () => {
    /**
     * 24 of the campaign's 80 conversions is 30%, and it stays 30% however many
     * rows are on screen. Normalising against the visible rows would make the
     * column always add to 100% and quietly redefine "the campaign" as "the people
     * still here" — which is the whole failure this screen is built to avoid.
     */
    const cell = contributionShareCell(contributionRow(), campaignTotalRow());
    expect(cell).toEqual({ kind: 'measured', text: '30%', value: 30 });
  });

  it('is null — not 0% — on a campaign that has booked nothing yet', () => {
    /**
     * A zero denominator through `ratePct`, so the cell is an em dash and a phrase
     * rather than `NaN%` or a confident `0%`. A campaign with 1,200 dials and no
     * conversions yet is ordinary, and every agent on it having "0% of the
     * conversions" is a sentence about a division that did not happen.
     */
    const cell = contributionShareCell(
      contributionRow({ successes: 0 }),
      campaignTotalRow({ successes: 0 }),
    );
    expect(cell.kind).toBe('unmeasured');
    expect(cell.text).toBe('—');
    if (cell.kind !== 'measured') {
      expect(cell.note).toBe('No conversions on this campaign yet');
    }
  });

  it('renders a real 0 as 0% when the campaign DID book', () => {
    // Measured-and-zero is a finding: this agent took calls on a campaign that
    // booked eighty and booked none of them. Softening that into "not measured"
    // would be the same dishonesty in the other direction.
    const cell = contributionShareCell(contributionRow({ successes: 0 }), campaignTotalRow());
    expect(cell).toEqual({ kind: 'measured', text: '0%', value: 0 });
  });

  it('goes BARE when the campaign line could not be read, rather than once per row', () => {
    /**
     * A different absence from "nothing to divide": the read failed, so this client
     * has no denominator at all rather than a zero one — and it is a fact about the
     * PAGE, not about this row.
     *
     * It used to carry `No campaign total to divide by`, which the page then said
     * once per row: forty-two times on a forty-agent campaign, in a column of
     * identical sentences nobody reads, burying the two places that can act on it
     * (the paragraph with a retry, and the footer cell spanning the metrics). So the
     * cell is an em dash and nothing else. `ContributionTable.test.tsx` asserts the
     * page states it exactly once.
     */
    const cell = contributionShareCell(contributionRow(), null);
    expect(cell.kind).toBe('unmeasured');
    expect(cell.text).toBe('—');
    if (cell.kind !== 'measured') expect(cell.note).toBe('');
  });

  it('gives the campaign line itself 100%, which is the total the column adds to', () => {
    const cell = contributionShareCell(campaignTotalRow(), campaignTotalRow());
    expect(cell).toEqual({ kind: 'measured', text: '100%', value: 100 });
  });
});

describe('agencyCampaignContribution — the asymmetry is said out loud', () => {
  it('says nothing when nothing was hidden', () => {
    // The common case. A note on every page is a note nobody reads.
    expect(contributionAsymmetryNote(contributionPage(), campaignTotalRow())).toBeNull();
  });

  it('names the gap, its cause and its remedy when rows were dropped', () => {
    /**
     * The campaign-grouped total INCLUDES a departed agent's attempts; the
     * per-agent rows EXCLUDE them by default. So the rows do not add up to the
     * total. Neither number is wrong — showing them adjacent with nothing said is.
     */
    const note = contributionAsymmetryNote(
      contributionPage({ inactive_omitted: 2 }),
      campaignTotalRow(),
    );

    expect(note).toContain('2 former team members');
    expect(note).toContain('do not add up');
    // The remedy is a checkbox on this screen, so it is named rather than left for
    // the reader to find.
    expect(note).toContain('Show former team members');
  });

  it('makes no QUANTITATIVE claim about the size of the gap', () => {
    /**
     * ⚠️ The sentence used to end *"their shares add to less than 100%, and the
     * difference is exactly those members' work"*, and that was false three
     * independent ways, all reachable:
     *
     *  1. Shares are conversions over conversions. A departed member with 40 dials
     *     and NO bookings moves no share at all — two visible agents on 50 and 30 of
     *     a campaign's 80 still render 62.5% + 37.5% = 100.0% while the sentence says
     *     they add to less.
     *  2. `unattributed_omitted` shrinks the rows for a second reason that "exactly
     *     those members' work" denies.
     *  3. `limit` is applied in SQL, so a truncated page renders this note and the
     *     truncation note together — and the old wording made them contradict each
     *     other on screen.
     *
     * So the note keeps the clause true in all of them (the rows do not add up),
     * names what is missing, and quantifies nothing. That is also the roster's
     * precedent: `inactiveNote` deliberately quantifies nothing either.
     */
    const note = contributionAsymmetryNote(
      contributionPage({ inactive_omitted: 2 }),
      campaignTotalRow(),
    );

    expect(note).not.toContain('less than 100%');
    expect(note).not.toContain('exactly');
  });

  it('names an unattributable row as what it is, never as a former member', () => {
    /**
     * The third state: an id with no membership row of any status. The API counts it
     * separately from `inactive_omitted` precisely because folding the two would
     * claim somebody left a team they were never on — so the sentence must not put
     * it in the same words, and the toggle must not be offered as a remedy for it,
     * because revealing former members does not put it back.
     */
    const note = contributionAsymmetryNote(
      contributionPage({ inactive_omitted: 0, unattributed_omitted: 2 }),
      campaignTotalRow(),
    );

    expect(note).toContain('2 rows could not be attributed to a person');
    expect(note).not.toContain('former team member');
    expect(note).not.toContain('Show former team members');
    expect(note).toContain('do not add up');
  });

  it('says both causes when both are present, and offers the toggle for the one it fixes', () => {
    const note = contributionAsymmetryNote(
      contributionPage({ inactive_omitted: 1, unattributed_omitted: 1 }),
      campaignTotalRow(),
    );

    expect(note).toContain('1 former team member is hidden here');
    expect(note).toContain('1 row could not be attributed to a person');
    expect(note).toContain('Show former team members');
  });

  it('treats an ABSENT unattributed count as zero, never as a claim', () => {
    /**
     * The API invented the field, so a console that ran ahead of it — or met the
     * degrade path where `asSpinePage` cannot recognise the API's body — must behave
     * exactly as it did before the field existed: say nothing about rows it was not
     * told about, rather than `NaN rows could not be attributed`.
     */
    const page = contributionPage({ inactive_omitted: 0 });
    delete (page as Partial<AgencyGroupPage>).unattributed_omitted;
    expect(contributionAsymmetryNote(page, campaignTotalRow())).toBeNull();

    const withDeparted = contributionPage({ inactive_omitted: 2 });
    delete (withDeparted as Partial<AgencyGroupPage>).unattributed_omitted;
    const note = contributionAsymmetryNote(withDeparted, campaignTotalRow());
    expect(note).toContain('2 former team members');
    expect(note).not.toContain('could not be attributed');
    expect(note).not.toContain('NaN');
  });

  it('says nothing at all when there are no rows to fail to add up', () => {
    /**
     * Every clause of this note is about "the rows below". A campaign whose every
     * dialer has since left the team has none: it is `ready` with an empty `rows`
     * and a non-zero `inactive_omitted`, and the caller renders a whole screen for
     * that case which names the same remedy. Both at once put "the rows below do not
     * add up to it" directly above the paragraph explaining that there are none.
     */
    expect(
      contributionAsymmetryNote(
        contributionPage({ rows: [], total_groups: 2, inactive_omitted: 2 }),
        campaignTotalRow(),
      ),
    ).toBeNull();
  });

  it('speaks of one former member in the singular', () => {
    const note = contributionAsymmetryNote(
      contributionPage({ inactive_omitted: 1 }),
      campaignTotalRow(),
    );
    expect(note).toContain('1 former team member');
    expect(note).not.toContain('1 former team members');
  });

  it('drops the reconciliation clause when there is no total on screen', () => {
    /**
     * With the campaign line unavailable there is nothing to fail to add up TO, so
     * the note says the part that is still true — work is missing from the rows —
     * rather than describing a comparison the reader cannot make.
     */
    const note = contributionAsymmetryNote(contributionPage({ inactive_omitted: 2 }), null);
    expect(note).toContain('2 former team members are hidden here');
    expect(note).toContain('work is missing from the rows below');
    expect(note).not.toContain('do not add up');
    expect(note).toContain('Show former team members');
  });

  it('falls silent when the API could not tell us how many were hidden', () => {
    /**
     * The API invented `inactive_omitted` and has a degrade path that serves the API's
     * body unrecognised. `undefined <= 0` is `false`, so an unguarded read would
     * render "NaN former team members hidden" on a page where nothing was.
     */
    const page = contributionPage();
    delete (page as Partial<AgencyGroupPage>).inactive_omitted;
    expect(contributionAsymmetryNote(page, campaignTotalRow())).toBeNull();
  });
});

describe('agencyCampaignContribution — three facts, and no fraction between them', () => {
  it('says the page was cut, and by which order', () => {
    const note = contributionTruncationNote(
      contributionPage({ total_groups: 240, limit: 200, rows: [contributionRow()] }),
    );
    expect(note).toBe(
      'Showing the top 200 by conversions — the rest are further down that order.',
    );
  });

  it('never renders a "showing N of M" fraction', () => {
    /**
     * Uncomputable, because of the ORDER the two services apply their rules in:
     * The API scopes, groups, ranks and cuts to `limit`, and the API then filters the
     * page it was handed. So `rows.length` is "the top `limit`, minus whichever
     * departed members happened to be inside it", and the API never saw the groups
     * the API cut.
     */
    const note = contributionTruncationNote(
      contributionPage({ total_groups: 240, limit: 200, inactive_omitted: 3 }),
    );
    expect(note).not.toContain(' of 240');
    expect(note).not.toContain('1 of');
  });

  it('says nothing when the whole campaign is on screen', () => {
    expect(contributionTruncationNote(contributionPage({ total_groups: 1 }))).toBeNull();
  });

  it('does not claim truncation when the only missing groups were departed members', () => {
    // A page that fitted comfortably under the limit and simply had a member
    // dropped was not truncated — `inactive_omitted` is added back before the
    // comparison, exactly as the roster does it.
    expect(
      contributionTruncationNote(
        contributionPage({ rows: [contributionRow()], total_groups: 3, inactive_omitted: 2 }),
      ),
    ).toBeNull();
  });

  it('does not claim truncation when the only missing groups were UNATTRIBUTABLE', () => {
    /**
     * The third state, and the second count that has to be added back. The server
     * counted these groups in `total_groups`; the server dropped them and reported them
     * separately from `inactive_omitted`, because an id with no membership row of
     * any status never was a member and calling it a former one would be false.
     *
     * Without them the comparison is `3 <= 1 + 0` — false — and the note then told a
     * supervisor looking at a complete page that the rest of the campaign was
     * further down an order.
     */
    expect(
      contributionTruncationNote(
        contributionPage({
          rows: [contributionRow()],
          total_groups: 3,
          inactive_omitted: 0,
          unattributed_omitted: 2,
        }),
      ),
    ).toBeNull();
  });

  it('adds BOTH drop counts back, not one of them', () => {
    // One of each, and a page of one row: 3 <= 1 + 1 + 1 holds only if both are
    // counted. Adding back just the departed member would fire the note.
    expect(
      contributionTruncationNote(
        contributionPage({
          rows: [contributionRow()],
          total_groups: 3,
          inactive_omitted: 1,
          unattributed_omitted: 1,
        }),
      ),
    ).toBeNull();
  });

  it('treats an ABSENT unattributed count as zero rather than as an excuse', () => {
    /**
     * The API invented the field. Absent must mean "nothing was dropped for that
     * reason" — today's behaviour — and NOT "assume something was", which would
     * suppress a truncation note on a page that really was cut. So a genuinely
     * truncated page still says so, and `undefined` never reaches the arithmetic
     * (`n <= rows.length + undefined` is `n <= NaN`, which is `false`).
     */
    const truncated = contributionPage({ total_groups: 240, limit: 200 });
    delete (truncated as Partial<AgencyGroupPage>).unattributed_omitted;
    expect(contributionTruncationNote(truncated)).toBe(
      'Showing the top 200 by conversions — the rest are further down that order.',
    );

    const complete = contributionPage({ rows: [contributionRow()], total_groups: 1 });
    delete (complete as Partial<AgencyGroupPage>).unattributed_omitted;
    expect(contributionTruncationNote(complete)).toBeNull();
  });

  it('falls silent rather than comparing against undefined', () => {
    // `total_groups <= rows.length + undefined` is `n <= NaN`, which is `false` —
    // so an unguarded version fired the note on EVERY page. The roster shipped
    // exactly that bug.
    const page = contributionPage({ total_groups: 240 });
    delete (page as Partial<AgencyGroupPage>).inactive_omitted;
    expect(contributionTruncationNote(page)).toBeNull();
  });

  it('reads out the population that dialled, not the row count', () => {
    /**
     * `total_groups` is the API's pre-limit, pre-filter count — with one campaign
     * filtered and `agent` grouped, a group IS an agent. `rows.length` would move
     * when a former member was dropped, which reads as the campaign having had
     * fewer people on it.
     */
    const page = contributionPage({ rows: [contributionRow()], total_groups: 6 });
    expect(contributionCountReadout(page)).toBe('6 agents dialled this campaign');
    expect(contributionCountReadout(contributionPage({ total_groups: 1 }))).toBe(
      '1 agent dialled this campaign',
    );
  });

  it('does not claim to be counting agents on a campaign it was not scoped to', () => {
    /**
     * Read off the ECHO rather than the request: a page that came back without one
     * campaign in scope is not describing agents on a campaign.
     *
     * It used to say `6 groups`, and "group" is the route's word for a row of an
     * aggregate — it belongs nowhere a supervisor can read it. There is also no true
     * short sentence to put in its place, because a group in a `campaign`-less read
     * is an agent-and-campaign PAIR rather than a person. So it is `null` and the
     * caller renders no readout, which is the honest amount to say about a branch
     * this view's own premise makes unreachable.
     */
    expect(
      contributionCountReadout(contributionPage({ campaign_id: null, total_groups: 6 })),
    ).toBeNull();
  });
});

describe('agencyCampaignContribution — a null rate is never 0%', () => {
  it('says which connect has not happened rather than printing 0%', () => {
    const cell = contributionConversionCell(
      contributionRow({ connected: 0, successes: 0, success_rate_pct: null, aht_seconds: null }),
    );
    expect(cell.kind).toBe('unmeasured');
    expect(cell.text).toBe('—');
    if (cell.kind !== 'measured') expect(cell.note).toBe('No connect to convert yet');
  });

  it('keeps a real 0 as a real answer', () => {
    // Forty connects and no bookings is a finding, and it is a different one from
    // "reached nobody".
    expect(contributionConversionCell(contributionRow({ success_rate_pct: 0 }))).toEqual({
      kind: 'measured',
      text: '0%',
      value: 0,
    });
  });

  it('says no call has finished rather than 0:00 handle time', () => {
    const cell = contributionHandleTimeCell(contributionRow({ aht_seconds: null }));
    if (cell.kind !== 'measured') expect(cell.note).toBe('No call has finished');
  });

  it('makes no claim at all for a connect rate this read cannot produce', () => {
    /**
     * `attempts >= 1` on every served row — `COUNT(*)` over an inner-joined
     * `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot emit a zero — so a null
     * connect rate is a shape violation rather than a state to explain. It renders
     * rather than throwing, and invents no finding about a row nobody can explain.
     */
    const cell = contributionConnectRateCell(contributionRow({ connect_rate_pct: null }));
    expect(cell).toEqual({ kind: 'unmeasured', text: '—', note: 'Not measured' });
  });
});

describe('agencyCampaignContribution — a thin row is not rated', () => {
  it('renders WORDS rather than the served connect rate, over DIALS', () => {
    /**
     * The rate is still on the payload — `connect_rate_pct: 81.8` — and the server
     * said not to report it. So the cell is the roster's `withheld`: words, and the
     * denominator beneath them. A greyed-out `81.8%` is still `81.8%`, and it is the
     * one that gets read aloud beside a named person's name.
     */
    const cell = contributionConnectRateCell(thinContributionRow());
    expect(cell.kind).toBe('withheld');
    expect(cell.text).toBe('Not enough calls');
    if (cell.kind !== 'measured') expect(cell.note).toBe('11 dials — too few to rate');
  });

  it('renders WORDS rather than the served conversion rate, over CONNECTS', () => {
    // Rates and their denominators travel together. This rate is over connects, and
    // its note says connects — the same rule, and the same words, as the roster's.
    const cell = contributionConversionCell(thinContributionRow());
    expect(cell.kind).toBe('withheld');
    if (cell.kind !== 'measured') expect(cell.note).toBe('9 connects — too few to rate');
  });

  it('says what has not happened BEFORE saying there is too little of it', () => {
    /**
     * A thin row that also reached nobody has no conversion rate to withhold, and
     * the `null` arm is checked first for that reason: "not enough calls" implies a
     * number is being held back, and here there is none. The roster's ordering.
     */
    const cell = contributionConversionCell(
      thinContributionRow({ connected: 0, successes: 0, success_rate_pct: null }),
    );
    expect(cell.kind).toBe('unmeasured');
    if (cell.kind !== 'measured') expect(cell.note).toBe('No connect to convert yet');
  });

  it('keeps a real 0 withheld rather than promoting it to a finding', () => {
    // `0` is measured-and-zero, but on eleven dials it is measured-and-meaningless.
    // The flag is about whether the rate may be QUOTED, and `0%` is a quote.
    expect(contributionConnectRateCell(thinContributionRow({ connect_rate_pct: 0 })).kind).toBe(
      'withheld',
    );
  });

  it('still shows AHT on a thin row — the flag is about rates, not durations', () => {
    /**
     * The roster's `handleTimeCell` precedent, followed rather than re-argued: a mean
     * over eleven finished calls is noisy but not misleading — it is genuinely how
     * long those eleven took — and withholding it would leave the thinnest row with
     * no readable figure at all, which is the row a supervisor opened this screen for.
     */
    expect(contributionHandleTimeCell(thinContributionRow())).toEqual({
      kind: 'measured',
      text: '1:15',
      value: 75,
    });
  });

  it('still shows Share on a thin row — its denominator is the CAMPAIGN', () => {
    /**
     * The sharper half of the same decision. Share is `3 / 80`: an exact fact about a
     * large denominator, not a rate estimated from a small one. And the column is read
     * for adding up to less than 100% by exactly the departed members' work — blanking
     * the thin rows' shares would make it fall short for a second, unstated reason and
     * turn `contributionAsymmetryNote` into a false explanation of the gap.
     */
    expect(contributionShareCell(thinContributionRow(), campaignTotalRow())).toEqual({
      kind: 'measured',
      text: '3.8%',
      value: 3.75,
    });
  });
});

describe('agencyCampaignContribution — a rate is gated on the denominator it divides by', () => {
  it('SHOWS the connect rate and WITHHOLDS the conversion rate on 41 dials, 11 connects', () => {
    /**
     * ⚠️ The defect this pass exists to fix, and the scoping document's own worked
     * example. The row clears the DIAL threshold, so its connect rate is quotable:
     * `26.8%` of 41 dials is a fact about a denominator big enough to quote. Its
     * conversion rate divides by ELEVEN, and `2 / 11 = 18.2%` is the figure that
     * document captions "not enough calls".
     *
     * Both directions are the defect: withholding the connect rate here would hide a
     * quotable figure, and showing the conversion rate prints a rate built from
     * eleven calls beside a named person under the heading "who drove this
     * campaign". One flag over one denominator cannot express two.
     */
    const row = hollowContributionRow();

    const connect = contributionConnectRateCell(row);
    expect(connect).toEqual({ kind: 'measured', text: '26.8%', value: 26.8 });

    const conversion = contributionConversionCell(row);
    expect(conversion.kind).toBe('withheld');
    expect(conversion.text).toBe('Not enough calls');
    // Its own denominator, in the plural it needs.
    if (conversion.kind !== 'measured') {
      expect(conversion.note).toBe('11 connects — too few to rate');
    }
  });

  it('leaves AHT and Share alone on that same row', () => {
    // The flag is about RATES. A mean over eleven finished calls is noisy but it is
    // genuinely how long those eleven took, and Share's denominator is the
    // CAMPAIGN's 80 conversions — `2 / 80` is exact.
    const row = hollowContributionRow();
    expect(contributionHandleTimeCell(row)).toEqual({
      kind: 'measured',
      text: '1:36',
      value: 96,
    });
    expect(contributionShareCell(row, campaignTotalRow())).toEqual({
      kind: 'measured',
      text: '2.5%',
      value: 2.5,
    });
  });

  it('honours the CONNECTS boundary in both directions, as the server drew it', () => {
    /**
     * Exactly on the threshold is quotable; one connect below is not. Both rows
     * carry the flags the server would compute for them and the console renders what
     * it was told — the fixtures' own derivation is bypassed here deliberately, so
     * this case pins the console's use of the answer rather than the fixture's
     * arithmetic.
     *
     * A threshold with no row sitting exactly on it is untested however much a file
     * header claims otherwise.
     */
    const onThreshold = contributionRow({
      connected: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      rates_reportable: true,
      success_rate_reportable: true,
    });
    const below = contributionRow({
      connected: AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1,
      rates_reportable: true,
      success_rate_reportable: false,
    });

    expect(contributionConversionCell(onThreshold).kind).toBe('measured');

    const withheld = contributionConversionCell(below);
    expect(withheld.kind).toBe('withheld');
    if (withheld.kind !== 'measured') expect(withheld.note).toBe('19 connects — too few to rate');
    // And the connect rate is untouched on both: its denominator did not move.
    expect(contributionConnectRateCell(below).kind).toBe('measured');
  });

  it('says "1 connect" rather than "1 connects" beside a withheld rate', () => {
    // Twenty dials and ONE connect is precisely the row this flag exists for, so the
    // singular is not a curiosity: "1 connects" reads as a rendering bug in the
    // sentence explaining a withheld number.
    const cell = contributionConversionCell(
      contributionRow({ connected: 1, successes: 1, success_rate_pct: 100 }),
    );
    expect(cell.kind).toBe('withheld');
    if (cell.kind !== 'measured') expect(cell.note).toBe('1 connect — too few to rate');
  });

  it('falls back to rates_reportable when the new flag is absent — never wider', () => {
    /**
     * Merge order is the API, then the console, so this console can meet a service that
     * predates the field. The fallback is the behaviour that shipped before it, and
     * the two tempting alternatives are both worse: `true` would REVEAL rates the
     * console withholds today, and re-deriving `connected >= 20` here would have
     * this client compute a threshold the mirrored constant's own doc comment forbids
     * it to compute.
     *
     * So a fat row keeps its rate, a thin row keeps it withheld — and the hollow row
     * loses the protection, which is exactly "today's behaviour" and the reason the
     * field was added rather than derived.
     */
    const fat = contributionRow();
    delete (fat as Partial<AgencyGroupRowWithName>).success_rate_reportable;
    expect(contributionSuccessRateReportable(fat)).toBe(true);
    expect(contributionConversionCell(fat).kind).toBe('measured');

    const thin = thinContributionRow();
    delete (thin as Partial<AgencyGroupRowWithName>).success_rate_reportable;
    expect(contributionSuccessRateReportable(thin)).toBe(false);
    expect(contributionConversionCell(thin).kind).toBe('withheld');

    const hollow = hollowContributionRow();
    delete (hollow as Partial<AgencyGroupRowWithName>).success_rate_reportable;
    expect(contributionSuccessRateReportable(hollow)).toBe(true);
  });

  it('withholds NOTHING when both flags are absent — an API that predates them', () => {
    // The permissive fallback, once, all the way down: `rates_reportable` absent
    // means "do not withhold", and the second flag then inherits that rather than
    // withholding every conversion rate on the screen.
    const legacy = hollowContributionRow();
    delete (legacy as Partial<AgencyGroupRowWithName>).success_rate_reportable;
    delete (legacy as Partial<AgencyGroupRowWithName>).rates_reportable;

    expect(contributionRatesReportable(legacy)).toBe(true);
    expect(contributionSuccessRateReportable(legacy)).toBe(true);
    expect(contributionConversionCell(legacy).kind).toBe('measured');
  });

  it('withholds on the new flag alone, without a second opinion', () => {
    /**
     * `success_rate_reportable` is strictly stronger than `rates_reportable`
     * (`connected <= attempts`, always), so the conversion rate gates on it ALONE.
     * A row the server marked quotable on connects is rendered, even where a client
     * comparing `attempts` to the mirrored 20 would have withheld it — the threshold
     * is the server's to tune, and the console's copy of the number is documented as
     * a thing to say out loud, never to compute with.
     */
    const tuned = contributionRow({
      attempts: 11,
      connected: 11,
      rates_reportable: true,
      success_rate_reportable: true,
    });
    expect(contributionConversionCell(tuned).kind).toBe('measured');

    const refused = contributionRow({ success_rate_reportable: false });
    expect(contributionConversionCell(refused).kind).toBe('withheld');
    // ...and its connect rate is still shown, on its own flag.
    expect(contributionConnectRateCell(refused).kind).toBe('measured');
  });
});

describe('agencyCampaignContribution — the threshold is the server’s', () => {
  it('honours the flag on the boundary, in both directions', () => {
    /**
     * Exactly on the threshold is reportable; one dial below is not. Both rows carry
     * the flag the server would compute for them, and the console renders what it was
     * told — this case pins the two sides of the boundary as the SERVER draws it.
     */
    const onThreshold = contributionRow({
      attempts: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      rates_reportable: true,
    });
    const below = contributionRow({
      attempts: AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1,
      rates_reportable: false,
    });

    expect(contributionConnectRateCell(onThreshold).kind).toBe('measured');

    const withheld = contributionConnectRateCell(below);
    expect(withheld.kind).toBe('withheld');
    if (withheld.kind !== 'measured') expect(withheld.note).toBe('19 dials — too few to rate');
  });

  it('never re-derives the threshold from the mirrored constant', () => {
    /**
     * The reason the flag exists at all. The API may tune
     * `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` or change which denominator it counts, and
     * this console's mirrored copy is then stale by definition — it is documented as a
     * number to SAY out loud, never to compute with. So a row under the mirrored 20
     * that the server nonetheless marked reportable is rated, and one over it that the
     * server marked unreportable is not. A client comparing `attempts` to the constant
     * would get both of these backwards.
     */
    expect(
      contributionConnectRateCell(contributionRow({ attempts: 11, rates_reportable: true })).kind,
    ).toBe('measured');
    expect(
      contributionConnectRateCell(contributionRow({ attempts: 900, rates_reportable: false })).kind,
    ).toBe('withheld');
  });

  it('does NOT withhold when the field is absent — the API may predate it', () => {
    /**
     * Merge order is the API, then the console, so this console can meet an API that has
     * not shipped the field yet, and the API has a documented degrade path that serves
     * the API's body unrecognised. The guard's fallback is the PERMISSIVE one: an absent
     * flag means "do not withhold", which is today's behaviour, rather than
     * withholding every rate on the screen — a table of "Not enough calls" beside rows
     * with hundreds of dials is a worse screen than the gap the field closed.
     */
    const legacy = contributionRow();
    delete (legacy as Partial<AgencyGroupRowWithName>).rates_reportable;

    expect(contributionRatesReportable(legacy)).toBe(true);
    expect(contributionConnectRateCell(legacy)).toEqual({
      kind: 'measured',
      text: '33.8%',
      value: 33.8,
    });
    expect(contributionConversionCell(legacy)).toEqual({
      kind: 'measured',
      text: '22.2%',
      value: 22.2,
    });
  });
});

describe('agencyCampaignContribution — naming a row', () => {
  it('uses the name the API resolved', () => {
    expect(contributionAgentName(contributionRow())).toBe('Ravi Kumar');
    expect(contributionNameResolved(contributionRow())).toBe(true);
  });

  it('falls back to a marked-as-an-id stand-in, never a blank', () => {
    // `agent_name: null` means UNRESOLVABLE — a deleted user, an id from outside the
    // tenant — and the same fallback the live floor and the roster use is what makes
    // that visible instead of rendering an empty cell.
    const row = contributionRow({ agent_name: null, key: { agent_user_id: '4f21ab90-aaaa' } });
    expect(contributionAgentName(row)).toBe('Agent 4f21ab90');
    expect(contributionNameResolved(row)).toBe(false);
  });

  it('claims nothing about a person when the key has no agent at all', () => {
    // A member is present iff its dimension was grouped, so an `agent`-grouped row
    // without one is a contract violation: it gets a word rather than "Agent " with
    // a trailing space, or a crash.
    expect(contributionAgentName(contributionRow({ agent_name: null, key: {} }))).toBe(
      'Unattributed',
    );
  });

  it('keys two unattributed rows apart', () => {
    const row = contributionRow({ key: {} });
    expect(contributionRowKey(row, 0)).not.toBe(contributionRowKey(row, 1));
    expect(contributionRowKey(contributionRow(), 3)).toBe('user-1');
  });
});
