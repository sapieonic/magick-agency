import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyGroupPage,
  type AgencyGroupRow,
  type AgencyGroupRowWithName,
} from '../../types/agency-stats';

/**
 * Contribution fixtures — the grouped read, as master serves it.
 *
 * ── COMPLETE, and the defaults are the honest case ────────────────────────
 * Same rule as `roster.ts`: every field the contract declares required is present,
 * because a payload missing one is a contract violation rather than an input the
 * console has to survive — and a fixture that omits one tests a situation that
 * cannot happen while hiding the ones that can.
 *
 * The trap this payload shares with `roster.ts` is `rates_reportable`. A fixture
 * that defaulted it to `false` — or left it undefined, which is falsy on the wire
 * but PERMISSIVE through the console's guard — would make the assertion that a THIN
 * row withholds its rates pass vacuously, or pass for the wrong reason. So the
 * default row is deliberately fat and reportable, thinness is opted into via
 * {@link thinContributionRow}, and the absent-field case is opted into explicitly.
 *
 * The trap specific to THIS payload is the pair of numbers the whole screen is
 * about. `contributionRow`'s conversions (24) are deliberately a clean share of
 * `campaignTotalRow`'s (80) — 30% — so a share assertion cannot pass on a rounding
 * accident, and the total is deliberately LARGER than the sum of the default rows,
 * because that is the shape master actually serves: the campaign's own line counts
 * everyone who dialled it, and the rows do not.
 *
 * ── The second flag is DERIVED here, because the server derives it ─────────
 * `success_rate_reportable` is `rates_reportable` AND `connected >= 20`, so a
 * fixture that hardcoded it could be overridden into a state core cannot emit — a
 * row with `rates_reportable: false` and a quotable conversion rate — and a test
 * would then pin behaviour on a payload that does not exist. So it is computed
 * from whatever the override left behind, exactly as core computes it, and an
 * EXPLICIT value still wins: the boundary cases pass the flag by hand precisely so
 * they are asserting the console's use of the server's answer rather than this
 * file's arithmetic.
 */

/** The server's own predicate, so the two flags on a fixture cannot disagree. */
function successReportable(row: { connected: number; rates_reportable?: boolean }): boolean {
  return row.rates_reportable !== false && row.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR;
}

/** One agent's line within one campaign. Everything measured, both flags true. */
export function contributionRow(
  over: Partial<AgencyGroupRowWithName> = {},
): AgencyGroupRowWithName {
  const row: AgencyGroupRowWithName = {
    key: { agent_user_id: 'user-1', campaign_id: 'camp-1' },
    agent_name: 'Ravi Kumar',
    attempts: 320,
    connected: 108,
    successes: 24,
    talk_seconds: 7_200,
    wrapup_seconds: 900,
    connect_rate_pct: 33.8,
    success_rate_pct: 22.2,
    aht_seconds: 75,
    rates_reportable: true,
    ...over,
  };
  return 'success_rate_reportable' in over
    ? row
    : { ...row, success_rate_reportable: successReportable(row) };
}

/**
 * A row the server told us not to rate — the grouped read's `thinRow`.
 *
 * The rates are STILL SERVED, which is the contract and is what makes printing
 * words instead of them a decision rather than an absence. 11 dials is under
 * `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` (20).
 *
 * The two denominators differ (11 dials, 9 connects) so a test can tell the connect
 * rate's withheld note from the conversion rate's, and the served rates are values
 * no other cell on the row can produce — `81.8%` and `33.3%` appear nowhere else,
 * so an assertion that they are ABSENT from the DOM cannot pass by coincidence.
 * `successes: 3` against the campaign's 80 makes the Share a real `3.8%`, which is
 * the figure that must still be there.
 */
export function thinContributionRow(
  over: Partial<AgencyGroupRowWithName> = {},
): AgencyGroupRowWithName {
  return contributionRow({
    key: { agent_user_id: 'user-thin', campaign_id: 'camp-1' },
    agent_name: 'Priya Nair',
    attempts: 11,
    connected: 9,
    successes: 3,
    connect_rate_pct: 81.8,
    success_rate_pct: 33.3,
    aht_seconds: 75,
    rates_reportable: false,
    ...over,
  });
}

/**
 * The campaign's OWN line — the second read, grouped by `campaign` alone.
 *
 * It carries no `agent_name` and its key has no `agent_user_id`, because no row of
 * this read belongs to a person. That is exactly why master drops nobody from it,
 * and therefore why it can exceed the rows above it.
 */
export function campaignTotalRow(over: Partial<AgencyGroupRow> = {}): AgencyGroupRow {
  const row: AgencyGroupRow = {
    key: { campaign_id: 'camp-1' },
    attempts: 1_200,
    connected: 400,
    successes: 80,
    talk_seconds: 26_000,
    wrapup_seconds: 3_000,
    connect_rate_pct: 33.3,
    success_rate_pct: 20,
    aht_seconds: 72.5,
    // 1,200 dials and 400 connects. The campaign's own line is reportable on BOTH
    // flags, and has to be: a footer reading "Not enough calls" would make every
    // row's Share unreadable, and it is also the benchmark the rows are read
    // against.
    rates_reportable: true,
    ...over,
  };
  return 'success_rate_reportable' in over
    ? row
    : { ...row, success_rate_reportable: successReportable(row) };
}

/**
 * The row this pass exists for: plenty of DIALS, too few CONNECTS.
 *
 * 41 dials and 11 connects is the scoping document's own worked example, and it is
 * the state one flag could not express. `rates_reportable` is TRUE — 41 dials
 * clears the dial threshold — so the connect rate is quotable and must be SHOWN.
 * `success_rate_reportable` is false, because the conversion rate divides by 11,
 * and `2 / 11 = 18.2%` is the figure the document captions "not enough calls".
 *
 * The two served rates (`26.8%` and `18.2%`) appear nowhere else in these
 * fixtures, so an assertion that one is on screen and the other is ABSENT cannot
 * pass by coincidence. Its Share is `2 / 80 = 2.5%`, which must stay on screen:
 * Share's denominator is the campaign's, not this row's.
 */
export function hollowContributionRow(
  over: Partial<AgencyGroupRowWithName> = {},
): AgencyGroupRowWithName {
  return contributionRow({
    key: { agent_user_id: 'user-hollow', campaign_id: 'camp-1' },
    agent_name: 'Anil Deshpande',
    attempts: 41,
    connected: 11,
    successes: 2,
    connect_rate_pct: 26.8,
    success_rate_pct: 18.2,
    aht_seconds: 96,
    rates_reportable: true,
    ...over,
  });
}

export function contributionPage(over: Partial<AgencyGroupPage> = {}): AgencyGroupPage {
  const rows = over.rows ?? [contributionRow()];
  return {
    from: '2026-08-24T00:00:00.000Z',
    to: '2026-08-26T09:00:00.000Z',
    /*
      ONE campaign, always, because that is the view's premise — a share of every
      campaign in the account is not a contribution. `group_by` echoes both
      dimensions in the vocabulary's canonical order, whatever order was requested.
    */
    campaign_id: 'camp-1',
    group_by: ['agent', 'campaign'],
    sort: 'successes',
    order: 'desc',
    limit: 200,
    // Defaults to "nothing was cut", so a truncation assertion has to set it and
    // cannot pass by accident.
    total_groups: rows.length,
    // And to "nothing was hidden", so the asymmetry note cannot pass vacuously
    // either — it is the sentence this whole screen exists to get right.
    inactive_omitted: 0,
    ...over,
    rows,
  };
}
