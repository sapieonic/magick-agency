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
