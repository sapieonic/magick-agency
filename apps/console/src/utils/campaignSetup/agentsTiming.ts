import type { AssignmentConfigState, CallingWindowState } from '../agencyCampaignConfigForm';
import { formatCount } from '../format/number';
import { daysPerWeekLabel, windowLabel } from './hoursPresets';
import { optionsOf, type RuleOption } from './ruleOptions';

/*
  The rules step 4 ("Agents & timing") says in words: the line under the agent list, the
  footer's Ready line (CS15), the wrap-up choices and which findings open the Advanced fold.
  Pure; the step (`pages/campaigns/agency/setup/AgentsTimingStep.tsx`) renders them.
*/

const minutes = (n: number) => `${formatCount(n)} minute${n === 1 ? '' : 's'}`;

/**
 * The line under the agent list: how customers reach the picked agents, for the campaign's
 * assignment mode (decisions CA1, CA4, CA5). Read from the stored mode whatever the contact
 * assignment flag, because pacing reads it either way (CA9).
 *
 *  - `pool`: pacing ignores owners, so any free agent takes the next customer, a call-back
 *    included (CA4 assigns call-backs only on `strict` and `preferred`).
 *  - `preferred` / `strict`: a call-back is the agent's who booked it (CA4). After the grace,
 *    if that agent is not working on the campaign, `callback_fallback: pool` frees it (on
 *    `strict` a freed contact is unassigned, so it waits for a supervisor, CA5) and `wait`
 *    keeps it theirs.
 */
export function staffingHint(assignment: Pick<AssignmentConfigState, 'mode' | 'callbackGraceMinutes' | 'callbackFallback'>): string {
  if (assignment.mode === 'pool') {
    return 'Any free agent takes the next customer. Call-backs go to whichever agent is free when they are due.';
  }
  const lead = assignment.mode === 'strict'
    ? 'Each agent calls only the customers assigned to them. Customers nobody is assigned are not called.'
    : 'Each agent calls the customers assigned to them first, then customers nobody is assigned.';
  const late = `If that agent is not working ${minutes(assignment.callbackGraceMinutes)} after it is due`;
  const fallback = assignment.callbackFallback === 'wait'
    ? 'A call-back goes to the agent who booked it, and waits for them.'
    : assignment.mode === 'strict'
      ? `A call-back goes to the agent who booked it. ${late}, it waits for a supervisor to assign it.`
      : `A call-back goes to the agent who booked it. ${late}, any free agent takes it.`;
  return `${lead} ${fallback}`;
}

/** "6 agents picked.", "1 agent picked.", "No agents picked yet." */
export function pickedLine(count: number): string {
  if (count === 0) return 'No agents picked yet.';
  return `${formatCount(count)} agent${count === 1 ? '' : 's'} picked.`;
}

function counted(n: number, singular: string, many: string): string {
  if (n === 0) return `no ${many}`;
  return `${formatCount(n)} ${n === 1 ? singular : many}`;
}

/**
 * The last step's footer (CS15): "Ready: 1,240 customers · 6 agents · 9 AM – 6 PM · 6 days a
 * week". `customers: null` leaves the count out (not known yet).
 */
export function readyLine({
  customers,
  agents,
  window,
}: {
  customers: number | null;
  agents: number;
  window: Pick<CallingWindowState, 'start' | 'end' | 'days'>;
}): string {
  const parts = [
    ...(customers === null ? [] : [counted(customers, 'customer', 'customers')]),
    counted(agents, 'agent', 'agents'),
    windowLabel(window.start, window.end),
    daysPerWeekLabel(window.days),
  ];
  return `Ready: ${parts.join(' · ')}`;
}

/* ── Wrap-up ──────────────────────────────────────────────────────────────── */

/** The wrap-up choices, in seconds (the validator allows any whole number 0–600). */
const WRAPUP_CHOICES = [0, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600] as const;

/** "No time", "30 sec", "1 min", "1 min 30 sec". */
export function wrapupLabel(seconds: number): string {
  if (seconds <= 0) return 'No time';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs} sec`;
  return secs === 0 ? `${mins} min` : `${mins} min ${secs} sec`;
}

/** The wrap-up select, with the current value kept as an option when it is not a choice. */
export function wrapupOptions(current: number): RuleOption[] {
  return optionsOf(WRAPUP_CHOICES, current, wrapupLabel);
}

/* ── The Advanced fold ────────────────────────────────────────────────────── */

/** The body paths of the settings inside "Advanced settings" (CS13). */
const ADVANCED_FIELDS = new Set([
  'abandonment_ceiling_pct',
  'abandonment_grace_ms',
  'wrapup_auto_return',
  'allow_wrapup_redial',
  'inbound_sticky_enabled',
  'assignment_mode',
  'on_unstaff',
  'callback_owner_grace_minutes',
  'callback_fallback',
  'allow_agent_retry',
  'agent_retry_rounds',
  'agent_retry_cooldown_minutes',
  'break_reasons',
]);

/** Whether a finding lives inside the fold: the fold then opens, so it can be seen and fixed. */
export function isAdvancedField(field: string): boolean {
  return (
    ADVANCED_FIELDS.has(field)
    || field.startsWith('retry_policy')
    || field.startsWith('outcome_dispositions')
    || field.startsWith('break_reasons[')
  );
}

/**
 * Whether a finding is inside the fold. `unansweredOutcomes` false: the step does not show the
 * automatic outcomes for unanswered calls, so their findings are not the fold's.
 */
export function hasAdvancedFinding(errors: Record<string, string>, unansweredOutcomes = true): boolean {
  return Object.keys(errors).some(
    (field) => isAdvancedField(field) && (unansweredOutcomes || !field.startsWith('outcome_dispositions')),
  );
}

/** The calling-window findings that only Custom's fields can show. */
export const CUSTOM_HOURS_FIELDS = ['calling_window_start', 'calling_window_end', 'default_timezone'] as const;
