/**
 * The four campaign setup steps (CS1, `docs/campaign-setup.md`), shared by New campaign (in
 * order) and a campaign's Settings (as tabs). The ids are stable: analytics, tests and links
 * carry them, so rename a title freely, never an id.
 */
export const SETUP_STEP_IDS = ['basics', 'contacts', 'purpose', 'agents'] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export interface SetupStep {
  id: SetupStepId;
  /** The card's bold line. */
  title: string;
  /** The card's grey line: what the step decides, in a few words. */
  subtitle: string;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'basics', title: 'Name & number', subtitle: 'Who customers see' },
  { id: 'contacts', title: 'Customers', subtitle: 'Upload the list' },
  { id: 'purpose', title: 'Purpose & buttons', subtitle: 'What agents can pick' },
  { id: 'agents', title: 'Agents & timing', subtitle: 'Who calls, and when' },
];

export function isSetupStepId(value: unknown): value is SetupStepId {
  return typeof value === 'string' && (SETUP_STEP_IDS as readonly string[]).includes(value);
}

export function setupStep(id: SetupStepId): SetupStep {
  return SETUP_STEPS.find((step) => step.id === id)!;
}

// Keys a server refusal uses for Name & number's fields (`validateConfig` produces none of them).
const BASICS_FIELDS = new Set(['name', 'caller_ids', 'telephony_provider', 'telephony_credential_id']);

/**
 * The step whose fields show a finding, in New campaign and in Settings alike: a body path as the
 * server keys its `details` and `validateConfig` its findings (`calling_window_end`,
 * `disposition_catalog[3].label`, `context_display.facts.0.key`). The name, numbers and carrier
 * are on Name & number; the customer card on Customers (CS9); the buttons, the automatic outcomes
 * for unanswered calls and a template's script on Purpose & buttons (CS19); everything else
 * (hours, retries, wrap-up, assignment, inbound, the abandonment limit, recording, the call
 * summary, breaks, the daily target and the number display) on Agents & timing.
 */
export function setupStepOfField(field: string): SetupStepId {
  if (BASICS_FIELDS.has(field)) return 'basics';
  if (field.startsWith('context_display')) return 'contacts';
  if (
    field.startsWith('disposition_catalog')
    || field.startsWith('outcome_dispositions')
    || field.startsWith('agent_script')
  ) {
    return 'purpose';
  }
  return 'agents';
}
