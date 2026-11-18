import { BUILDER_STEPS, type BuilderStepId } from './builderFlow';
import { OUTCOME_LABELS, type CampaignConfigState } from '../../../utils/agency/config/configConstants';
import type { AgencyRetryOutcome } from '../../../types/agency-campaign';
import { joinAnd } from '../../../utils/agencyCampaignConfigForm';

/*
  Where a config finding belongs in the builder, and what the builder says about it.

  `validateConfig` keys its findings by body path (`calling_window_end`,
  `disposition_catalog[3].requires_promise`). The field that path names renders its own
  message on its step, but Save is on every step and Review shows every setting, so the
  builder also has to say WHICH step holds a finding. Without that, a finding on a step the
  operator is not looking at is a disabled Save beside "Fix the highlighted fields" with
  nothing highlighted, and the operator has no way to find it.
*/

const HOURS_FIELDS = new Set(['calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone']);
const BASICS_FIELDS = new Set(['name', 'caller_ids', 'telephony_provider', 'telephony_credential_id']);
const ASSIGNMENT_FIELDS = new Set([
  'assignment_mode',
  'on_unstaff',
  'callback_owner_grace_minutes',
  'callback_fallback',
  'allow_agent_retry',
  'agent_retry_rounds',
  'agent_retry_cooldown_minutes',
]);

/** The step whose editor renders this field. Anything not on Basics or Hours is on "How agents work". */
export function stepForConfigField(field: string): BuilderStepId {
  if (BASICS_FIELDS.has(field)) return 'basics';
  if (HOURS_FIELDS.has(field)) return 'hours';
  return 'behaviour';
}

/** The Review rows a finding can be shown on. */
export type ReviewRowId =
  | 'name'
  | 'callFrom'
  | 'hours'
  | 'outcomes'
  | 'unanswered'
  | 'wrapup'
  | 'assignment'
  | 'abandonment'
  | 'recording';

/** The Review row that summarises this field's setting. */
export function reviewRowForConfigField(field: string): ReviewRowId {
  if (field === 'name') return 'name';
  if (BASICS_FIELDS.has(field)) return 'callFrom';
  if (HOURS_FIELDS.has(field)) return 'hours';
  if (field.startsWith('disposition_catalog')) return 'outcomes';
  // The retries table and the automatic outcomes are both about calls nobody answered.
  if (field.startsWith('retry_policy') || field.startsWith('outcome_dispositions')) return 'unanswered';
  if (field.startsWith('wrapup') || field === 'allow_wrapup_redial') return 'wrapup';
  if (ASSIGNMENT_FIELDS.has(field)) return 'assignment';
  if (field === 'abandonment_ceiling_pct') return 'abandonment';
  if (field === 'record_calls') return 'recording';
  // Anything else the form renders is on "How agents work"; Outcomes is that step's first row.
  return 'outcomes';
}

/** How many findings each step holds, in step order. Steps with none are left out. */
export function findingsByStep(errors: Record<string, string>): Map<BuilderStepId, number> {
  const counts = new Map<BuilderStepId, number>();
  for (const field of Object.keys(errors)) {
    const step = stepForConfigField(field);
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  const ordered = new Map<BuilderStepId, number>();
  for (const { id } of BUILDER_STEPS) {
    const count = counts.get(id);
    if (count !== undefined) ordered.set(id, count);
  }
  return ordered;
}

function stepTitle(id: BuilderStepId): string {
  return BUILDER_STEPS.find((step) => step.id === id)?.title ?? id;
}

/**
 * Why Save is held, said where the operator is.
 *
 * On the step that holds every finding, the fields are highlighted right there. Anywhere
 * else the sentence names the step (or steps), so nobody is told to fix a field they cannot
 * see. `null` when nothing holds the save.
 */
export function saveBlockCopy(byStep: Map<BuilderStepId, number>, current: BuilderStepId): string | null {
  let total = 0;
  for (const count of byStep.values()) total += count;
  if (total === 0) return null;

  if (byStep.size === 1 && byStep.has(current)) {
    return total === 1 ? 'Fix the highlighted field to save.' : `Fix the ${total} highlighted fields to save.`;
  }

  const where = [...byStep.keys()].map((id) => (id === current ? 'this step' : stepTitle(id)));
  const settings = total === 1 ? '1 setting' : `${total} settings`;
  return `Can’t save yet: ${settings} on ${joinAnd(where)} ${total === 1 ? 'needs' : 'need'} fixing.`;
}

/** The first step holding a finding that is not the one on screen, for a "Go to" button. */
export function firstOtherStepWithFindings(
  byStep: Map<BuilderStepId, number>,
  current: BuilderStepId,
): BuilderStepId | null {
  for (const id of byStep.keys()) if (id !== current) return id;
  return null;
}

export function goToStepLabel(id: BuilderStepId): string {
  return `Go to ${stepTitle(id)}`;
}

const CATALOG_INDEX = /^disposition_catalog\[(\d+)\]/;
const OUTCOME_KEY = /^(?:retry_policy|outcome_dispositions)\.([a-z_]+)/;

/**
 * Review's findings, each with enough context to be read away from its field.
 *
 * On its step a finding sits under the outcome it is about. On Review it does not, so
 * "Every outcome needs a label" has to say which outcome: the row's label, its code, or its
 * place in the list when it has neither.
 */
export function reviewFindings(
  errors: Record<string, string>,
  config: CampaignConfigState,
): Map<ReviewRowId, string[]> {
  const rows = new Map<ReviewRowId, string[]>();
  for (const [field, message] of Object.entries(errors)) {
    const row = reviewRowForConfigField(field);
    const lines = rows.get(row) ?? [];
    lines.push(`${contextFor(field, config)}${message}`);
    rows.set(row, lines);
  }
  return rows;
}

function contextFor(field: string, config: CampaignConfigState): string {
  const catalog = CATALOG_INDEX.exec(field);
  if (catalog) {
    const index = Number(catalog[1]);
    const entry = config.dispositions[index];
    const name = entry?.label.trim() || entry?.code || `Outcome ${index + 1}`;
    return `${name}: `;
  }
  // A retry rule or an automatic outcome is one row per kind of unanswered call: say which.
  const outcome = OUTCOME_KEY.exec(field);
  if (!outcome) return '';
  const label = OUTCOME_LABELS[outcome[1] as AgencyRetryOutcome] ?? outcome[1];
  return field.startsWith('retry_policy') ? `${label} retries: ` : `${label}: `;
}
