import { SETUP_STEPS, setupStep, type SetupStepId } from '../../../utils/campaignSetup/setupSteps';
import { joinAnd } from '../../../utils/agencyCampaignConfigForm';

/*
  Where a config finding belongs in New campaign, and what the page says about it.

  `validateConfig` keys its findings by body path (`calling_window_end`,
  `disposition_catalog[3].requires_promise`). The field that path names renders its own
  message on its step, but Save as draft and Start are in every step's footer, so the page also
  has to say WHICH step holds a finding. Without that, a finding on a step the operator is not
  looking at is a disabled Save beside "Fix the highlighted fields" with nothing highlighted.
  With the Review step gone (CS1), the step cards' needs-fixing marks and the footer's line are
  the only places a finding elsewhere is named.
*/

// Not produced by `validateConfig`: keys of a server refusal, mapped so a finding on them
// names Name & number. The page shows such a refusal on the step's own fields.
const BASICS_FIELDS = new Set(['name', 'caller_ids', 'telephony_provider', 'telephony_credential_id']);

/**
 * The step whose editor renders this field: the buttons and the automatic outcomes for
 * unanswered calls are on Purpose & buttons; the name, numbers and carrier on Name & number;
 * everything else (hours, retries, wrap-up, assignment, inbound, the abandonment limit,
 * recording, the call summary, the agent screen and break limits) on Agents & timing.
 */
export function stepForConfigField(field: string): SetupStepId {
  if (BASICS_FIELDS.has(field)) return 'basics';
  if (field.startsWith('disposition_catalog') || field.startsWith('outcome_dispositions')) return 'purpose';
  return 'agents';
}

/** How many findings each step holds, in step order. Steps with none are left out. */
export function findingsByStep(errors: Record<string, string>): Map<SetupStepId, number> {
  const counts = new Map<SetupStepId, number>();
  for (const field of Object.keys(errors)) {
    const step = stepForConfigField(field);
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  const ordered = new Map<SetupStepId, number>();
  for (const { id } of SETUP_STEPS) {
    const count = counts.get(id);
    if (count !== undefined) ordered.set(id, count);
  }
  return ordered;
}

/**
 * Why Save is held, said where the operator is.
 *
 * On the step that holds every finding, the fields are highlighted right there. Anywhere
 * else the sentence names the step (or steps), so nobody is told to fix a field they cannot
 * see. `null` when nothing holds the save.
 */
export function saveBlockCopy(byStep: Map<SetupStepId, number>, current: SetupStepId): string | null {
  let total = 0;
  for (const count of byStep.values()) total += count;
  if (total === 0) return null;

  if (byStep.size === 1 && byStep.has(current)) {
    return total === 1 ? 'Fix the highlighted field to save.' : `Fix the ${total} highlighted fields to save.`;
  }

  const where = [...byStep.keys()].map((id) => (id === current ? 'this step' : setupStep(id).title));
  const settings = total === 1 ? '1 setting' : `${total} settings`;
  return `Can’t save yet: ${settings} on ${joinAnd(where)} ${total === 1 ? 'needs' : 'need'} fixing.`;
}

/** The first step holding a finding that is not the one on screen, for a "Go to" button. */
export function firstOtherStepWithFindings(
  byStep: Map<SetupStepId, number>,
  current: SetupStepId,
): SetupStepId | null {
  for (const id of byStep.keys()) if (id !== current) return id;
  return null;
}

export function goToStepLabel(id: SetupStepId): string {
  return `Go to ${setupStep(id).title}`;
}
