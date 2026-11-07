/**
 * The pacing history's counters (`agency_campaign_pacing_minutes`, migration 0013), in table
 * order, the pacing engine's idle reasons, and the column each one counts into. A leaf (the
 * contracts only): the repository builds its SQL from it and the pacing engine and its
 * accumulator count by it, and the engine's unit suites mock the repository barrel, so the list
 * cannot live behind it.
 */
import { AGENCY_PACING_IDLE_REASONS, type AgencyPacingIdleReason } from '@magick-agency/contracts/api/agency/insights';

export const PACING_HISTORY_FIELDS = [
  'ticks',
  'outside_hours_ticks',
  'idle_no_agents',
  'idle_no_slots',
  'idle_no_contacts',
  'idle_no_reservations',
  'idle_no_caller_ids',
  'idle_nothing_due',
  'calling_hours_deferrals',
  'dnc_unavailable_halts',
  'dials_placed',
  'predial_dnc_suppressed',
  'predial_invalid_suppressed',
  'our_fault_retired',
  'redials_refused_at_limit',
] as const;

export type PacingHistoryField = (typeof PACING_HISTORY_FIELDS)[number];

/** The idle column of each reason (`agency_tick_idle_total`'s label → the column). */
export const PACING_IDLE_FIELD: Readonly<Record<AgencyPacingIdleReason, PacingHistoryField>> = {
  no_agents: 'idle_no_agents',
  no_slots: 'idle_no_slots',
  no_contacts: 'idle_no_contacts',
  no_reservations: 'idle_no_reservations',
  no_caller_ids: 'idle_no_caller_ids',
  nothing_due: 'idle_nothing_due',
};

/**
 * Why a pacing tick dialled nothing: `agency_tick_idle_total`'s `reason` label. A closed set.
 * Every reason the insights page shows (`AGENCY_PACING_IDLE_REASONS`, one history column each),
 * plus the ones that are the metric's alone and count into an existing column
 * ({@link PACING_TICK_IDLE_FIELD}):
 *
 *  - `dedications_unavailable`: agents and slots were there, but the campaign's dedicated
 *    caller IDs (DN1) could not be read, so the tick reserved and claimed nothing. Not benign,
 *    and not quiescent (the next tick reads again). The history counts it as
 *    `idle_no_reservations` ("Could not reserve an agent"): what a supervisor sees is true (no
 *    agent was taken for a call), there is nothing on the campaign for them to fix, and a
 *    column of its own would be a migration and a wire change for a database fault, which
 *    Grafana (this label) is where an operator looks for.
 */
export const TICK_IDLE_REASONS = [...AGENCY_PACING_IDLE_REASONS, 'dedications_unavailable'] as const;

export type TickIdleReason = (typeof TICK_IDLE_REASONS)[number];

/** The history column of every tick idle reason: {@link PACING_IDLE_FIELD} and the metric's own. */
export const PACING_TICK_IDLE_FIELD: Readonly<Record<TickIdleReason, PacingHistoryField>> = {
  ...PACING_IDLE_FIELD,
  dedications_unavailable: 'idle_no_reservations',
};
