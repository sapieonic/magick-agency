import {
  AGENCY_STALL_PRIORITY,
  type AgencyStall,
  type AgencyStallCode,
  type AgencyCampaignStats,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';

/**
 * ─── THE CAMPAIGN HEALTH STRIP — THE ASSEMBLER ──────────────────────────────
 *
 * **This is the feature.** The strip is what the supervisor dashboard is for:
 * without a reason field the
 * dashboard degrades to "0 in flight" with no explanation, and a campaign stopped
 * for a *compliance* reason looks identical to one that is broken. A supervisor
 * cannot tell those apart from numbers alone, and they require opposite actions.
 *
 * ── Why this is not in the repository ────────────────────────────────────────
 *
 * Four of the diagnoses the dialer runtime makes need a signal no SQL query can see:
 * DNC availability, the account concurrency guard's live Redis counter, the
 * calling-hours evaluation (a pure function over campaign config + contact
 * timezone), and the frozen pause evidence on the campaign row. `stats()` stays a
 * repository method returning repository facts; this composes.
 *
 * ── Ranking, and why it is by ACTION rather than severity ────────────────────
 *
 * `AGENCY_STALL_PRIORITY` is ordered by what a supervisor should *do*. A
 * compliance stop (1, 2) outranks a staffing problem (3), which outranks a
 * capacity one (4), because acting on the wrong diagnosis wastes exactly the
 * minutes the strip exists to save. Two examples that decide the order:
 *
 *   * `dnc_unavailable` sits above `no_agents_available` because it is
 *     tenant-wide and no amount of staffing fixes it.
 *   * `concurrency_saturated` sits below staffing because it has **no action**
 *     (concurrency is super-admin only, so there is no setter and the remedy is
 *     contacting support) — a strip whose top line offers
 *     nothing to do reads as broken.
 *
 * There is no `credits_low` diagnosis: the app has no credits (decision S6).
 */

/** Everything the assembler needs that it cannot compute itself. */
export interface CampaignHealthInputs {
  campaign: AgencyCampaignRecord;
  /**
   * The repository half of the payload — already computed, not recomputed here.
   *
   * `agents` is excluded as well as the route fields: the assembler diagnoses
   * staffing from `agents_by_state`/`agents_live`, never from the roster itself.
   * Saying so in the type keeps this independent of the floor's per-agent columns —
   * `connected` is composed at the route, and requiring the full row here would
   * couple the health strip to a Redis read it has no use for.
   */
  stats: Omit<
    AgencyCampaignStats,
    (typeof import('@magick-agency/contracts/agency').AGENCY_STATS_ROUTE_FIELDS)[number] | 'agents'
  >;
  /**
   * `null` when the DNC registry could not answer — the `dnc_entries` read failed
   * (`dnc-availability.ts`). Dialing fails CLOSED on this, so it is a stall,
   * not a warning.
   */
  dncAppliedVersion: number | null;
  concurrencyLimit: number;
  /** `null` when Redis could not give a trustworthy cross-replica count. */
  concurrencyInUse: number | null;
  /**
   * Pending contacts whose calling window is shut right now.
   *
   * Counted over **every** pending contact, not only those due — see diagnosis 5.
   * Must stay the same population as `stats.contacts_pending`, which it is
   * compared against.
   */
  contactsOutsideCallingHours: number;
  /** When the earliest such window next opens, if one resolves. */
  nextCallingWindowOpensAt: Date | null;
  /** The earliest scheduled retry, when nothing is dialable now. */
  nextRetryAt: Date | null;
  /** This campaign's most recent dial, for the "last dial 4m 12s ago" line. */
  lastDialAt: Date | null;
  /** Failed/total over the recent window, for diagnosis 8. */
  recentFailures: { attempts: number; failed: number; windowMinutes: number };
  /** Break codes to counts, for the "5 on break (Lunch)" breakdown. */
  onBreakByReason: Record<string, number>;
}

/**
 * The share of recent dials that must fail before it is worth naming.
 *
 * 30%: high enough that ordinary no-answer traffic does not trip it (a cold list
 * legitimately fails most dials — `no_answer` is NOT counted as a failure here,
 * only outcomes that indicate OUR side or the carrier), low enough to catch a
 * carrier fault before a whole shift is wasted.
 */
export const ELEVATED_FAILURE_RATE_PCT = 30;

/**
 * Minimum attempts before the failure rate is reportable.
 *
 * Without it, one failed dial in a two-minute-old campaign is "50% of dials
 * failed — possible carrier problem", which is the strip crying wolf on its
 * lowest-priority diagnosis and is how supervisors learn to ignore it.
 */
export const ELEVATED_FAILURE_MIN_ATTEMPTS = 10;

/**
 * The window the failure-rate message names ("in the last 10 minutes").
 *
 * Exported and imported by the repository rather than restated in the SQL, so the
 * number the query measures over and the number the console prints cannot drift —
 * a strip that says "10 minutes" over a 30-minute window is a lie a supervisor
 * would act on.
 */
export const RECENT_FAILURE_WINDOW_MINUTES = 10;

/** Utilisation at which the concurrency diagnosis fires. */
function saturated(inUse: number | null, limit: number): boolean {
  // `null` in-use is NOT saturation. Redis being unreadable tells us nothing
  // about headroom, and inventing saturation would tell a supervisor to contact
  // support about a limit that may be nowhere near reached.
  return inUse !== null && limit > 0 && inUse >= limit;
}

/**
 * Every diagnosis that currently applies, ranked, with its evidence.
 *
 * Pure and total. Returns them all rather than just the winner so the caller can
 * fill both `stall` and `other_stalls` from one pass, and so a test can assert the
 * ranking independently of which one happens to win.
 */
export function diagnoseAll(input: CampaignHealthInputs): AgencyStall[] {
  const { campaign, stats } = input;
  const found = new Map<AgencyStallCode, AgencyStall>();

  // 1 — the compliance stop. Reads the FROZEN evidence on the campaign row, not a
  // live rate: the 24h window keeps sliding while the campaign sits paused, so a
  // live read would eventually render "2.1% is over your 3% limit".
  if (campaign.pause_reason === 'abandonment_ceiling') {
    found.set('auto_paused_abandonment', {
      code: 'auto_paused_abandonment',
      measured_pct: campaign.pause_abandonment_rate_pct ?? 0,
      ceiling_pct: campaign.abandonment_ceiling_pct,
      paused_at: (campaign.paused_at ?? new Date()).toISOString(),
    });
  }

  // 2 — fails CLOSED, and the supervisor must be told loudly. A campaign that has
  // silently stopped for a compliance-safety reason is indistinguishable from a
  // broken one, which is the whole argument for this diagnosis existing.
  if (input.dncAppliedVersion === null) {
    found.set('dnc_unavailable', { code: 'dnc_unavailable', tenant_wide: true });
  }

  // 3 — staffing. `agents_by_state` is already on the repository half.
  const byState = stats.agents_by_state;
  const onShift = stats.agents_live;
  if (onShift > 0 && byState.available === 0 && byState.reserved === 0) {
    found.set('no_agents_available', {
      code: 'no_agents_available',
      agents_on_shift: onShift,
      on_break_by_reason: input.onBreakByReason,
      on_call: byState.on_call,
      last_dial_at: input.lastDialAt?.toISOString() ?? null,
    });
  }

  // 4 — capacity. Account-wide, shared with every campaign on the account.
  if (saturated(input.concurrencyInUse, input.concurrencyLimit)) {
    found.set('concurrency_saturated', {
      code: 'concurrency_saturated',
      limit: input.concurrencyLimit,
      in_use: input.concurrencyInUse!,
    });
  }

  // 5 — calling hours. Only when EVERYTHING waiting is shut out; a campaign with
  // some dialable contacts is not stalled by calling hours.
  //
  // **The comparison is only sound because both sides count the same set.**
  // `contacts_pending` is a bare `state = 'pending'` count, and
  // `contactsOutsideCallingHours` is derived from `healthInputs.pendingByTimezone`,
  // which is now the same population grouped by timezone. It used to be filtered to
  // `next_attempt_at <= now()`, which made this a due-only numerator over an
  // all-pending denominator: one scheduled retry was enough to suppress the
  // diagnosis, and the pre-dial gate's own deferral of out-of-hours contacts
  // eventually emptied the numerator entirely. If either count's population is ever
  // narrowed again, narrow the other in the same commit or this silently stops
  // firing — which is the failure mode that is hardest to notice, because the strip
  // showing nothing is indistinguishable from a healthy campaign.
  if (input.contactsOutsideCallingHours > 0
    && input.contactsOutsideCallingHours >= stats.contacts_pending) {
    found.set('outside_calling_hours', {
      code: 'outside_calling_hours',
      contacts_waiting: input.contactsOutsideCallingHours,
      next_window_opens_at: input.nextCallingWindowOpensAt?.toISOString() ?? null,
    });
  }

  // 6 — the contact state machine's distinction, which the dashboard must not conflate: "list
  // exhausted with retries scheduled" and "complete" are genuinely different, and
  // only the second means the work is done.
  if (stats.contacts_pending === 0 && stats.retries_pending > 0) {
    found.set('list_exhausted_retries_pending', {
      code: 'list_exhausted_retries_pending',
      retries_pending: stats.retries_pending,
      next_retry_at: input.nextRetryAt?.toISOString() ?? null,
    });
  }

  // 7 — none: there is no `credits_low` (decision S6).

  // 8 — the carrier-fault hint, last because it is a guess and the least
  // actionable of the eight.
  const { attempts, failed, windowMinutes } = input.recentFailures;
  if (attempts >= ELEVATED_FAILURE_MIN_ATTEMPTS) {
    const pct = (failed / attempts) * 100;
    if (pct >= ELEVATED_FAILURE_RATE_PCT) {
      found.set('elevated_failure_rate', {
        code: 'elevated_failure_rate',
        failed_pct: pct,
        attempts,
        window_minutes: windowMinutes,
      });
    }
  }

  // Ranked by the exported priority, never by insertion order — the branches above
  // are written in priority order today and a future edit must not be able to
  // change which single diagnosis a supervisor sees by moving one.
  const ranked: AgencyStall[] = [];
  for (const code of AGENCY_STALL_PRIORITY) {
    const hit = found.get(code);
    if (hit) ranked.push(hit);
  }
  return ranked;
}

/** The two payload fields the strip renders, from one diagnosis pass. */
export function campaignHealth(input: CampaignHealthInputs): {
  stall: AgencyStall | null;
  other_stalls: AgencyStallCode[];
} {
  const ranked = diagnoseAll(input);
  return {
    stall: ranked[0] ?? null,
    other_stalls: ranked.slice(1).map((s) => s.code),
  };
}
