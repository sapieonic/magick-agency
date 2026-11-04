/**
 * The pacing history's counters (`agency_campaign_pacing_minutes`, migration 0013), in table
 * order, and the column each pacing idle reason counts into. A leaf (contract types only): the
 * repository builds its SQL from it and the pacing engine and its accumulator count by it, and
 * the engine's unit suites mock the repository barrel, so the list cannot live behind it.
 */
import type { AgencyPacingIdleReason } from '@magick-agency/contracts/api/agency/insights';

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
