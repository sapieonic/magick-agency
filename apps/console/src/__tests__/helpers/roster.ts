import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyRosterAgentRowWithName,
  type AgencyRosterBenchmark,
  type AgencyRosterPage,
} from '../../types/agency-stats';

/**
 * Roster fixtures, shared by the table's tests, the section's and the page's.
 *
 * ── Why they are COMPLETE rather than partial ──────────────────────────────
 * Every field the wire contract declares required is present here, and the
 * builders take an override object rather than a `Partial<>` of the whole shape.
 * The reason is the lesson `AgencyAnalyticsPage.test.tsx` already records about
 * its stall fixture: a payload missing a required field is a contract violation,
 * not an input the console has to survive, so a fixture that omits one tests a
 * situation that cannot happen while hiding the ones that can.
 *
 * The specific trap on this surface is `rates_reportable`. A fixture that
 * defaulted it to `false` (or left it undefined, which is falsy) would make every
 * row in every test render "not enough calls" — and the assertion that a THIN row
 * does so would pass vacuously, which is precisely the failure mode the phase-01
 * contract names as MAG-106. So the default row is deliberately fat and
 * reportable, and thinness is opted into.
 *
 * ── `success_rate_reportable` is DERIVED, because the server derives it ────
 * It is `rates_reportable` AND `connected >= 20`, so hardcoding it would let an
 * override produce a row core cannot emit — `rates_reportable: false` beside a
 * quotable conversion rate — and a test would then pin behaviour on a payload that
 * does not exist. It is computed from whatever the override left behind, exactly as
 * core computes it, and an EXPLICIT value still wins: the boundary and legacy cases
 * pass it by hand, so they assert the console's use of the server's answer rather
 * than this file's arithmetic.
 */

/** The server's own predicate, so the two flags on a fixture cannot disagree. */
function successReportable(row: { connected: number; rates_reportable: boolean }): boolean {
  return row.rates_reportable && row.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR;
}

/** A fat, reportable row. Sortable defaults; everything measured; both flags true. */
export function rosterRow(
  over: Partial<AgencyRosterAgentRowWithName> = {},
): AgencyRosterAgentRowWithName {
  const row: AgencyRosterAgentRowWithName = {
    agent_user_id: 'user-1',
    agent_name: 'Ravi Kumar',
    attempts: 320,
    connected: 108,
    successes: 24,
    talk_seconds: 7_200,
    wrapup_seconds: 900,
    connect_rate_pct: 33.8,
    success_rate_pct: 22.2,
    aht_seconds: 75,
    campaigns: 2,
    shift_seconds: 21_600,
    break_seconds: 1_800,
    occupancy_pct: 37.5,
    last_dialed_at: '2026-08-19T11:04:00.000Z',
    rates_reportable: true,
    ...over,
  };
  return 'success_rate_reportable' in over
    ? row
    : { ...row, success_rate_reportable: successReportable(row) };
}

/**
 * Plenty of DIALS, too few CONNECTS — the row one flag could not describe.
 *
 * 400 dials and 3 connects is the shape the benchmark's own doc comment names: it
 * is `rates_reportable: true`, it IS in the connect-rate pool, and it is absent
 * from the success-rate and AHT pools. So its connect rate must be shown and its
 * conversion rate must be withheld — the same row, two answers, which is the whole
 * reason `success_rate_reportable` exists.
 *
 * `33.3%` (1 of 3) is the served conversion rate and appears nowhere else in these
 * fixtures, so asserting it is ABSENT from the DOM cannot pass by coincidence.
 */
export function hollowRow(
  over: Partial<AgencyRosterAgentRowWithName> = {},
): AgencyRosterAgentRowWithName {
  return rosterRow({
    agent_user_id: 'user-hollow',
    agent_name: 'Anil Deshpande',
    attempts: 400,
    connected: 3,
    successes: 1,
    connect_rate_pct: 0.8,
    success_rate_pct: 33.3,
    aht_seconds: 96,
    campaigns: 1,
    rates_reportable: true,
    ...over,
  });
}

/**
 * A row the server told us not to rate.
 *
 * The rates are STILL SERVED — that is the contract, and it is what makes the
 * console's decision to print words instead of them a decision rather than an
 * absence. 11 dials is under `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` (20).
 */
export function thinRow(
  over: Partial<AgencyRosterAgentRowWithName> = {},
): AgencyRosterAgentRowWithName {
  return rosterRow({
    agent_user_id: 'user-thin',
    agent_name: 'Priya Nair',
    attempts: 11,
    connected: 11,
    successes: 3,
    connect_rate_pct: 100,
    success_rate_pct: 27.3,
    campaigns: 1,
    rates_reportable: false,
    ...over,
  });
}

export function rosterBenchmark(over: Partial<AgencyRosterBenchmark> = {}): AgencyRosterBenchmark {
  return {
    agents: 8,
    agents_rated: 6,
    attempts: 2_495,
    connected: 811,
    successes: 149,
    talk_seconds: 54_000,
    wrapup_seconds: 6_400,
    /**
     * The pooled shift and the break inside it — phase 02a's D10, and present by
     * default for the same reason `rates_reportable` defaults to `true` above.
     *
     * A fixture that omitted them would make every team-row assertion pass against
     * the FALLBACK path (the median stand-in that preceded the field), and the case
     * asserting that fallback is reached would then pass vacuously. So the default
     * fixture carries them and the absence is opted into — see the cases that
     * delete them explicitly.
     *
     * Chosen so the pooled rate is legible and is NOT the median: 54,000 + 6,400
     * handled over 151,000 on shift is exactly 40%, against an `occupancy_pct`
     * median of 38.5%. A fixture where the two coincided could not tell the pooled
     * figure from the stand-in.
     */
    shift_seconds: 151_000,
    break_seconds: 7_200,
    connect_rate_pct: 32.5,
    success_rate_pct: 18.4,
    aht_seconds: 74,
    connect_rate: { p25: 28.4, median: 34.1, p75: 41.2 },
    success_rate: { p25: 14.2, median: 18, p75: 23.6 },
    // SECONDS, not percentages — the band beside a handle time reads `1:14`, never
    // `74%`. The median matches `aht_seconds` above, as a real cohort's would.
    aht: { p25: 62, median: 74, p75: 91 },
    occupancy_pct: { p25: 31, median: 38.5, p75: 46.2 },
    ...over,
  };
}

export function rosterPage(over: Partial<AgencyRosterPage> = {}): AgencyRosterPage {
  const rows = over.rows ?? [rosterRow()];
  return {
    from: '2026-08-24T00:00:00.000Z',
    to: '2026-08-26T09:00:00.000Z',
    /**
     * ONE campaign, because that is what the console now asks for by default.
     *
     * It used to be `null`, which is the POOLED read — every campaign in the
     * account in one cohort. The band comparison is switched off in that view (a
     * median across different dealers' lead lists is not like-for-like, see
     * `cohortComparable`), so a fixture defaulting to `null` would make every
     * assertion about a band chip pass vacuously. Same reasoning as
     * `rates_reportable` above: the default fixture is the comparable case, and the
     * pooled one is opted into with `rosterPage({ campaign_id: null })`.
     */
    campaign_id: 'camp-1',
    sort: 'successes',
    order: 'desc',
    limit: 100,
    // Defaults to "nothing was cut", so a truncation assertion has to set it and
    // cannot pass by accident.
    total_agents: rows.length,
    benchmark: rosterBenchmark(),
    inactive_omitted: 0,
    ...over,
    rows,
  };
}
