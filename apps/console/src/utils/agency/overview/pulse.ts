import type { AgencyAgentLiveState, AgencyCampaignStats } from '../../../types/agency-campaign';
import { AGENCY_FLOOR_STATE_LABELS } from '../../agencyAgentFloor';
import { ratesWithheld } from '../../agencyCampaignPerformance';
import { formatCount, pct, plural } from '../../format/number';
import { stateShares } from '../metrics';
import { DASH, type OverviewFigure, countFigure } from './figure';

/*
  The pulse strip and the live rail: the list-worked ring, the six pulse
  figures, and the floor as a bar. Out of `agencyCampaignOverview.ts`, which
  re-exports everything here.
*/

/**
 * A rate's sub-line, or `null`.
 *
 * Three ways to get `null`, and the third is the interesting one:
 *
 * - `undefined` — the field didn't arrive.
 * - `null` — the server carried it and has nothing to measure.
 * - **The campaign has too few dials to publish a percentage at all.**
 *
 * That last is `ratesWithheld`, imported from `agencyCampaignPerformance`
 * rather than re-implemented here, and the import is the point. The Performance
 * section refuses to print a rate under {@link RATE_MIN_ATTEMPTS} dials, in
 * those words. If this strip kept its own rule — or no rule — a four-dial
 * campaign would read "50% of dials placed" on Overview and "Not enough dials"
 * one tab away, which is worse than either answer alone: a supervisor who saw
 * both would have no way to tell which section was lying. One predicate, so the
 * two sections cannot drift.
 *
 * Overview drops the line rather than printing the Performance card's sentence:
 * a pulse cell is a number and a caption, with no room to explain a threshold,
 * and the section that does have room is one click away.
 */
function rateSub(
  rate: number | null | undefined,
  of: string,
  withheld: boolean,
): string | null {
  if (withheld || typeof rate !== 'number') return null;
  return `${pct(rate)} ${of}`;
}

// ── The contact funnel ──────────────────────────────────────────────────────

export const RING_RADIUS = 30;

export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ListWorkedRing {
  known: boolean;
  /** The share of the list that will never be dialed again, or `null`. */
  percent: number | null;
  /** {@link percent} formatted for the middle of the ring, or `—`. */
  label: string;
  /** `N of M contacts`, or a sentence saying why there is no figure. */
  caption: string;
  /** The arc's `stroke-dasharray`. `0` draws nothing, which is correct. */
  dashArray: string;
}

/**
 * How much of the list is finished with — completed, suppressed or exhausted.
 *
 * Those three and no others: they are the states nothing dials again. `pending`
 * and `in_flight` are both still ahead of the dialer, and counting in-flight
 * calls as worked would make the ring tick backwards when a call ends and its
 * contact returns to the queue for a retry.
 *
 * All three components AND the total are required. A ring drawn from two of
 * three understates the campaign by an unknowable amount while looking exactly
 * as authoritative as a complete one.
 */
export function listWorkedRing(stats: AgencyCampaignStats | null): ListWorkedRing {
  const total = stats?.contacts_total;
  const parts = [stats?.contacts_completed, stats?.contacts_suppressed, stats?.contacts_exhausted];

  const unknown = (caption: string): ListWorkedRing => ({
    known: false,
    percent: null,
    label: DASH,
    caption,
    dashArray: `0 ${RING_CIRCUMFERENCE.toFixed(1)}`,
  });

  if (typeof total !== 'number' || parts.some((p) => typeof p !== 'number')) {
    return unknown('The contact counts didn’t load.');
  }
  if (total <= 0) {
    // Not 0% worked — there is no list to have worked through.
    return unknown('No contacts have been added to this campaign yet.');
  }

  const worked = (parts as number[]).reduce((sum, p) => sum + p, 0);
  /*
    More contacts finished than exist. Not a state the server produces, but a payload
    assembled mid-deploy from two versions is, and the arc was already clamped
    while the number beside it was not — so the ring drew a full circle with
    "160%" in the middle of it and captioned it "16 of 10 contacts".

    Nothing here is salvageable: a percentage over 100 is not a rounding error,
    it means one of the four counts is from a different read. The module's other
    guard against exactly this (`retriesPlacedSub`, "a screen nobody can act on,
    so it says nothing instead") takes the same way out.
  */
  if (worked > total) {
    return unknown('These counts don’t add up yet — they were read a moment apart.');
  }

  const percent = (worked / total) * 100;
  const dash = (RING_CIRCUMFERENCE * Math.min(Math.max(percent, 0), 100)) / 100;

  return {
    known: true,
    percent,
    label: `${Math.round(percent)}%`,
    caption: `${formatCount(worked)} of ${formatCount(total)} contacts`,
    dashArray: `${dash.toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`,
  };
}

// ── The pulse strip ─────────────────────────────────────────────────────────

export interface PulseFigures {
  /** `attempts_total` — every call placed, retries included. */
  dials: OverviewFigure;
  /** `attempts_connected` — attempts that reached anybody at all. */
  reached: OverviewFigure;
  /** `human_connects`, carrying `connect_rate_pct`, which is its own rate. */
  humans: OverviewFigure;
  /** `attempts_success`, carrying `success_rate_pct`. */
  wins: OverviewFigure;
  /** `attempts_live`, carrying the floor behind it. */
  live: OverviewFigure;
}

export function pulseFigures(stats: AgencyCampaignStats | null): PulseFigures {
  const floor = floorSummary(stats);
  // One predicate, shared with the Performance section. See `rateSub`.
  const withheld = ratesWithheld(stats);

  return {
    dials: {
      ...countFigure(stats?.attempts_total),
      /*
        `attempts_total` silently includes retries. A supervisor reading "6,742
        dials" against a 2,100-contact list has no way to reconcile the two, and
        the reconciliation they reach for — the list was dialed three times over
        — is wrong. See `retriesPlacedSub`.
      */
      sub: retriesPlacedSub(stats),
    },
    /*
      Deliberately no sub-line. The only rate on the payload whose numerator
      could sit above it is `connect_rate_pct`, and that rate counts
      `human_connects` — a smaller number than this cell's. It belongs to the
      cell below.
    */
    reached: countFigure(stats?.attempts_connected),
    humans: {
      ...countFigure(stats?.human_connects),
      sub: rateSub(stats?.connect_rate_pct, 'of dials placed', withheld),
    },
    wins: {
      ...countFigure(stats?.attempts_success),
      sub: rateSub(stats?.success_rate_pct, 'of calls that reached someone', withheld),
    },
    live: {
      ...countFigure(stats?.attempts_live),
      sub: floor.shiftSub,
    },
  };
}

/**
 * "including 1,922 retries", or `null`.
 *
 * ── Why a `0` produces no line ─────────────────────────────────────────────
 * A campaign with nothing retried does not need to be told so beneath its dial
 * count: "including 0 retries" costs a read and settles a question nobody asked.
 * That is the same rule {@link retriesNote} applies to the queue, and unlike the
 * rates above it is a rule about USEFULNESS, not about honesty — the `0` here
 * is a real measurement.
 *
 * ── Why an absent field produces no line either ────────────────────────────
 * `attempts_retried` is one of the two NICE-TO-HAVE fields on this payload, so
 * an older server simply does not send it. There is nothing to
 * fall back on: retries cannot be derived from any other field here, and
 * `retries_pending` counts a different population entirely (what is queued, not
 * what was placed). So the line is dropped, and the dial count reads exactly as
 * it did before the field existed.
 *
 * Guarded against a retry count above the total, which is not a number the server can
 * produce but is one a mid-deploy pairing of two versions could: "including
 * 8,000 retries" under "6,742 dials" is a screen nobody can act on, so it says
 * nothing instead.
 */
function retriesPlacedSub(stats: AgencyCampaignStats | null): string | null {
  const retried = stats?.attempts_retried;
  if (typeof retried !== 'number' || retried <= 0) return null;
  const total = stats?.attempts_total;
  if (typeof total === 'number' && retried > total) return null;
  return `including ${plural(retried, 'retry', 'retries')}`;
}

// ── The live floor, as the rail reads it ────────────────────────────────────

/**
 * Bar order for the floor: busiest first, and `offline` is absent entirely.
 *
 * An agent who signed out is not on shift — the same rule the server's `shift_seconds`
 * applies and the same one `foldOccupancy` keeps on the agent performance page.
 * Including them would dilute every share by signed-out time and make "3 of 9
 * free" a fraction of a floor that is not there.
 */
const FLOOR_BAR_ORDER: readonly AgencyAgentLiveState[] = [
  'on_call',
  'wrapup',
  'reserved',
  'available',
  'break',
] as const;

export interface FloorSlice {
  state: AgencyAgentLiveState;
  label: string;
  count: number;
  /** Share of the agents on shift. */
  percent: number;
}

export interface FloorSummary {
  /** True only when the payload carried a floor to describe. */
  known: boolean;
  /** Agents on shift — every state except `offline` — or `null`. */
  onShift: number | null;
  /** {@link onShift} formatted, or `—`. */
  onShiftLabel: string;
  /** Positive states only, in bar order. */
  slices: FloorSlice[];
  /** `N agents on shift · M free`, or `null` when neither figure is known. */
  shiftSub: string | null;
}

/**
 * The floor as a bar and a key.
 *
 * `agents_by_state` is preferred over `agents_live` because it is the only one
 * of the two that can answer "how many are FREE", and because summing it lets
 * `offline` be excluded from the shift. `agents_live` is the fallback for a
 * payload that predates the per-state roster: it yields a total with no
 * breakdown, which draws no bar and says only what it knows.
 */
export function floorSummary(stats: AgencyCampaignStats | null): FloorSummary {
  const byState = stats?.agents_by_state;

  if (!byState) {
    const live = stats?.agents_live;
    if (typeof live !== 'number') {
      return { known: false, onShift: null, onShiftLabel: DASH, slices: [], shiftSub: null };
    }
    return {
      known: true,
      onShift: live,
      onShiftLabel: formatCount(live),
      slices: [],
      shiftSub: `${plural(live, 'agent')} on shift`,
    };
  }

  // A non-number count is skipped, not summed — see `stateShares`.
  const { total: onShift, shares } = stateShares(byState, FLOOR_BAR_ORDER);
  const slices = shares.map<FloorSlice>(({ state, value, share }) => ({
    state,
    label: AGENCY_FLOOR_STATE_LABELS[state],
    count: value,
    percent: share,
  }));

  const free = shares.find((entry) => entry.state === 'available')?.value ?? 0;
  return {
    known: true,
    onShift,
    onShiftLabel: formatCount(onShift),
    slices,
    shiftSub: `${plural(onShift, 'agent')} on shift · ${formatCount(free)} free`,
  };
}

// ── "How it ran" ────────────────────────────────────────────────────────────
