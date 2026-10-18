import { ON_SHIFT_STATES, ratePct, stateShares } from './agency/metrics';
import { assignmentEntry } from './agencyAssignmentEntry';
import { AGENCY_FLOOR_STATE_LABELS } from './agencyAgentFloor';
import type { AgencyAgentLiveState } from '../types/agency-campaign';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../types/agency-stats';
import type {
  AgencyAgentStats,
  AgencyOccupancy,
  AgencyStaffingHistoryEntry,
} from '../types/agency-stats';
import { agentPct, agentSeconds } from './agency/agentReadouts';
// The windows, the day series and the readouts live in `./agency/`, re-exported
// so every import of this module keeps working.
export * from './agency/agentWindows';
export * from './agency/buckets';
export * from './agency/agentReadouts';

/**
 * The agent performance surface's derivations, as pure functions.
 *
 * Same reasoning as `agencyCampaignPerformance` and `agencyHealthStrip`: every
 * sentence produced here is a claim about a person's shift, and a derivation is
 * a place to be confidently wrong. They are tested against fixtures rather than
 * eyeballed on a screen.
 *
 * ── The one rule the whole module is built around ───────────────────────────
 * **A `null` rate is NOT MEASURED YET, and must never render as `0.0%`.** The
 * house precedent is `abandonment_rate_24h_pct` — *"a health strip with no
 * diagnosis reads as nothing wrong when the truth is nothing measured"* — and it
 * bites harder here, because the reader is the person being measured. `0.0%`
 * conversion on an agent's first morning is the product telling them they failed
 * at something they have not yet had the chance to do.
 *
 * So there are three absences and they read differently, exactly as they do on
 * the supervisor's side:
 *
 *  1. **`undefined`** — the payload did not carry the field. An em dash and
 *     "didn't load". Never `0`, and never "no data".
 *  2. **`null`** — the server carried it and has nothing to measure. "Not
 *     measured yet", with a sentence naming what has not happened.
 *  3. **A real `0`** — rendered as `0`. The only one of the three that is a
 *     claim about the shift, and the one the other two must not be confused
 *     with.
 *
 * ── Dials and conversations are never collapsed ─────────────────────────────
 * `attempts` and `connected` are always surfaced as two numbers with the connect
 * rate between them (`headlineTrio`). That is a product decision rather than a
 * layout one: "calls" is ambiguous in exactly the way that matters to somebody
 * being measured on it, and an agent who reads one number cannot tell whether
 * they are being credited for dialling or for talking. The labels say which is
 * which in the product's words, not in the wire's.
 */

// ─── The periods ─────────────────────────────────────────────────────────────

/**
 * A percentage from a part and a whole, or `null` on a zero denominator — the one
 * division helper, now in `agency/metrics.ts` beside its `ratio` and the
 * state-share sum, and re-exported here for the modules that import it from
 * this one. See its doc comment for why there is exactly one.
 */
export { ratePct };

/**
 * The states the breakdown is made of, busiest first — and `offline` is not one
 * of them.
 *
 * ── Why the order ───────────────────────────────────────────────────────────
 * Deliberately the floor's state summary order rather than the wire enum's:
 * someone reading where their shift went wants the working states first.
 *
 * ── Why `offline` is absent, which is the load-bearing half ────────────────
 * It is not a presentational preference — it is what makes the shares agree with
 * the denominator the server publishes. The dialer runtime defines `shift_seconds` as the sum
 * of the states **excluding** `offline` (`foldOccupancy`, `src/agency/
 * agent-record.ts`: `if (row.state !== 'offline') occupancy.shift_seconds +=
 * clamped`), on the stated ground that *"an agent who logged out at 17:00 was
 * not on shift at 18:00, and folding that into the denominator would make every
 * short shift look unoccupied"*.
 *
 * Summing all six here contradicted that twice over. Every share was diluted by
 * time the agent was signed out — 30 of 90 worked minutes on calls read as 6.7%
 * rather than 33% for somebody whose shift was one part of a long day — and the
 * recorded sum could then only ever be ≥ `shift_seconds`, which made
 * {@link OccupancyBreakdown.unaccountedSeconds} structurally zero and the gap
 * note below it unreachable code.
 *
 * `offline` is still on the payload and that is right: "logged out" and "no
 * data" are different facts, and only one of them is a hole in the record. It is
 * simply not part of the shift being broken down.
 */
const OCCUPANCY_ORDER: readonly AgencyAgentLiveState[] = ON_SHIFT_STATES;

export interface OccupancySegment {
  state: AgencyAgentLiveState;
  label: string;
  seconds: number;
  /** Share of the ON-SHIFT states that were recorded — see the docstring. */
  sharePct: number;
}

export interface OccupancyBreakdown {
  /**
   * False when there is nothing to show. The caller must render **nothing** in
   * that case — never a zeroed bar.
   */
  measured: boolean;
  segments: OccupancySegment[];
  /**
   * The sum of the recorded ON-SHIFT states, which is the shares' denominator.
   * `offline` is not in it; see {@link OCCUPANCY_ORDER}.
   */
  recordedSeconds: number;
  /**
   * `shift_seconds` minus {@link recordedSeconds}, when the shift is longer than
   * the states account for. `0` when they agree.
   *
   * Reachable precisely BECAUSE `offline` is out of the sum. While it was in,
   * the recorded total could only ever be ≥ `shift_seconds` (which excludes it),
   * so this was structurally `0` and the sentence the caller renders from it was
   * dead code.
   */
  unaccountedSeconds: number;
}

/**
 * Where the shift went — or the honest admission that we do not know.
 *
 * ── Why "all zeros" is unmeasured rather than a shift of nothing ────────────
 * The server computes occupancy from its agent-state event log, which shipped after
 * the dialer itself. A session that predates the log emits no events, so the API
 * answers with **zeros, not nulls** — and a zeroed breakdown drawn as a bar is a
 * confident claim that an agent spent a shift doing nothing whatsoever. That is
 * the same defect as rendering a null rate as `0.0%`, in a different costume,
 * and it is aimed at the same person.
 *
 * The check is on the **sum of the states** rather than on `shift_seconds`
 * alone, and the asymmetry is load-bearing in both directions:
 *
 *  - a non-zero `shift_seconds` with every state at zero is exactly the
 *    pre-event-log case, so trusting `shift_seconds` would draw the bar it is
 *    meant to suppress;
 *  - a zero `shift_seconds` with real state seconds is a gappy log rather than
 *    an absence, and suppressing that would discard measurements we have.
 *
 * ── Shares are of what was RECORDED, and the gap is named ──────────────────
 * The states can sum to less than `shift_seconds` — a browser closed mid-state,
 * a session the reaper closed. `AgencyOccupancy.shift_seconds` says so in its
 * own contract. Dividing by `shift_seconds` would then produce shares that
 * quietly refuse to reach 100%, which reads as a rounding bug. So the
 * denominator is the recorded sum and the remainder is returned separately for
 * the caller to say out loud.
 *
 * ── `offline` is in neither the denominator nor the segments ───────────────
 * Because it is in neither on the server's side: `shift_seconds` is the sum of the
 * states except `offline`. See {@link OCCUPANCY_ORDER} for the two things
 * including it broke — every share diluted by signed-out time, and the gap above
 * made unreachable.
 *
 * A period in which the ONLY recorded state is `offline` is therefore
 * `measured: false`: the shift it describes is zero seconds long, and there is
 * no such thing as a share of it. That is the same answer the server gives — a
 * `shift_seconds` of 0 — rather than a separate client opinion.
 */
export function occupancyBreakdown(
  occupancy: AgencyOccupancy | null | undefined,
): OccupancyBreakdown {
  const byState = occupancy?.by_state;
  if (!byState) {
    return { measured: false, segments: [], recordedSeconds: 0, unaccountedSeconds: 0 };
  }

  /*
    The ON-SHIFT states only. This is the same sum the server calls `shift_seconds`,
    computed from the same six-key record, which is what lets the remainder below
    mean "the shift covers time the states do not account for" rather than
    "these two numbers were never comparable". A non-number state is skipped,
    not summed — see `stateShares`.
  */
  const { total: recorded, shares } = stateShares(byState, OCCUPANCY_ORDER);
  if (recorded <= 0) {
    return { measured: false, segments: [], recordedSeconds: 0, unaccountedSeconds: 0 };
  }

  const shift = occupancy?.shift_seconds ?? 0;
  return {
    measured: true,
    recordedSeconds: recorded,
    unaccountedSeconds: Math.max(0, shift - recorded),
    /*
      Zero-length states are dropped rather than rendered as a 0% row
      (`stateShares`). Unlike a zero rate, an unused state is not a withheld
      measurement — an agent who took no break genuinely took no break — and six
      rows where two carry the shift makes the two harder to read.
    */
    segments: shares.map(({ state, value, share }) => ({
      state,
      label: AGENCY_FLOOR_STATE_LABELS[state],
      seconds: value,
      sharePct: share,
    })),
  };
}

/** `m:ss` / `h:mm:ss` for an occupancy row, and the share beside it. */
export function occupancySegmentText(segment: OccupancySegment): string {
  return `${agentSeconds(segment.seconds)} · ${agentPct(segment.sharePct)}`;
}

// ─── The day-wise series ─────────────────────────────────────────────────────

/** Why there is no occupancy breakdown — never a zeroed bar. See {@link occupancyBreakdown}. */
export const OCCUPANCY_UNMEASURED_NOTE =
  'We don’t have a record of how this time was spent. Shifts are only broken down like '
  + 'this from the point we started tracking station activity, so older shifts show nothing '
  + 'here rather than showing zeros.';

// ─── Staffing history ────────────────────────────────────────────────────────

export interface StaffingSummary {
  /**
   * DISTINCT campaigns the agent has ever been staffed on.
   *
   * Not `entries.length`. A staffing history repeats campaigns **by
   * construction** — the API's own docstring for `/my-campaigns` spells it out:
   * *"staffed in March, unstaffed in April, staffed again in June is three rows
   * and one campaign"*. So a row count printed under a heading reading "Campaigns
   * you've worked" told an agent they had worked three campaigns when they had
   * worked one, and it did it most often to the people with the longest history.
   */
  campaigns: number;
  /**
   * Assignment ROWS that have not ended — a different axis from the three counts
   * around it. See the docstring, and see the caller for why it is not in the
   * same middot chain.
   */
  active: number;
  /**
   * Distinct campaigns that will never send another call — `stopped` or
   * `completed`.
   *
   * Read through `assignmentEntry` rather than through a second status list.
   * That module already owns "may an agent enter this", its allow-list-of-blocks
   * shape means a status the server adds is treated as enterable rather than as
   * finished, and a second mapping here would be the copy that goes stale.
   */
  finished: number;
  /**
   * Distinct campaigns that are staffed and enterable, but not dialing right
   * now — paused, draft, stopping.
   */
  waiting: number;
}

/**
 * How much of the dialer this agent has seen, and how much of it is over.
 *
 * ── Two axes, and they must not be added together ───────────────────────────
 * `active` counts ASSIGNMENTS: The API's own `active` flag rather than
 * `unassigned_at === null`, because the API owns the staffing table and is
 * entitled to end an assignment in ways this client has no business modelling.
 *
 * `campaigns`, `waiting` and `finished` count CAMPAIGNS, because that is what
 * their words mean and what the section they are printed in is a list of.
 * `waiting` and `finished` are derived from the CAMPAIGN's status rather than the
 * assignment's, since an assignment can be perfectly current on a campaign that
 * stopped dialing last week — which is also exactly why the two axes overlap: one
 * paused campaign an agent is still staffed on is counted by `active` AND by
 * `waiting`. Neither count is wrong; adding them is, and putting them in one
 * middot chain is an invitation to. The caller therefore renders one axis as the
 * chain and the other beside it.
 *
 * ── Deduplication, and where it does NOT apply ─────────────────────────────
 * Every campaign-axis count is over distinct `campaign_id`s. A history repeats a
 * campaign by construction (the API's own words: three rows, one campaign), so a
 * row count under a heading that says "campaigns" is simply a different number
 * from the one it claims to be — and a campaign that was paused across two
 * separate stints was counted as two waiting campaigns.
 *
 * `active` is deliberately NOT deduplicated: it is a count of live assignment
 * rows, which is what the API's flag is per, and two concurrent live assignments
 * to one campaign would be a real thing about the staffing table rather than
 * double counting. It is also the count whose word ("current") does not say
 * "campaign".
 */
export function staffingSummary(entries: AgencyStaffingHistoryEntry[]): StaffingSummary {
  let active = 0;
  /*
    Per campaign, not per row — and `Map`, not two `Set`s, because a campaign's
    status is a property of the CAMPAIGN and every row for it carries the same
    value. Last one wins, which is the same answer as first one wins; what
    matters is that it is counted once.
  */
  const statusByCampaign = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.active) active += 1;
    statusByCampaign.set(entry.campaign_id, entry.campaign_status);
  }

  let finished = 0;
  let waiting = 0;
  for (const status of statusByCampaign.values()) {
    const { canEnter, note } = assignmentEntry(status);
    if (!canEnter) finished += 1;
    else if (note !== null) waiting += 1;
  }

  return { campaigns: statusByCampaign.size, active, finished, waiting };
}

/**
 * The campaign's name for a breakdown row, or a stand-in.
 *
 * `by_campaign[]` carries ids and no names — the API's contract, not an omission
 * — so the name is resolved from a list the caller already holds. An id with no
 * match renders as a shortened id: never blank, and never a name this client
 * invented for a campaign the server declined to identify.
 */
export function campaignLabel(
  campaignId: string,
  names: ReadonlyMap<string, string | null>,
): string {
  const name = names.get(campaignId);
  if (name) return name;
  return `Campaign ${campaignId.slice(0, 8)}`;
}

/** Names by id, from whatever list the surface has — staffing history or the campaign list. */
export function campaignNameMap(
  rows: readonly { campaign_id?: string; id?: string; campaign_name?: string | null; name?: string | null }[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows) {
    const id = row.campaign_id ?? row.id;
    if (!id) continue;
    map.set(id, row.campaign_name ?? row.name ?? null);
  }
  return map;
}

/** Talk time for one campaign row, so the table and the totals agree on format. */
export function rowSeconds(value: number | undefined): string {
  return typeof value === 'number' ? agentSeconds(value) : '—';
}

/** A rate for one campaign row, derived HERE only because the server sends none. */
export function rowConnectRate(row: { attempts: number; connected: number }): string {
  /*
    The one place this module divides. `by_campaign[]` carries counts and no
    rates, and a per-campaign connect rate is the whole reason a supervisor or an
    agent reads that table — but the guard matters: zero dials is "not measured
    yet", exactly as `connect_rate_pct: null` is on the totals, and printing
    `0.0%` for a campaign nobody has dialled yet would be the same lie by
    arithmetic instead of by wire.

    And the roster's floor: below AGENCY_ROSTER_MIN_RATE_DENOMINATOR dials the
    roster withholds this same agent's connect rate (`rates_reportable`), so this
    table does too, in the roster's words — it printed `100%` for one dial and one
    connect beside a withheld roster cell.
  */
  if (row.attempts <= 0) return '—';
  if (row.attempts < AGENCY_ROSTER_MIN_RATE_DENOMINATOR) return 'Not enough calls';
  const rate = ratePct(row.connected, row.attempts);
  return rate === null ? '—' : agentPct(rate);
}

/** Whether a stats payload describes a range in which literally nothing happened. */
export function isEmptyRange(stats: AgencyAgentStats | null): boolean {
  if (!stats) return false;
  return stats.totals.attempts === 0 && stats.buckets.length === 0;
}
