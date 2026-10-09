import type { UploadPhase } from '../../../hooks/useRosterIngest';

/**
 * The guided create-campaign path.
 *
 * The old builder put every section on screen at once. That made the
 * upload → map → ingest sequence honest (you could jump back after a bad
 * mapping) and made everything else a wall: name, caller IDs, hours,
 * dispositions, retries and wrap-up competed for the first look.
 *
 * This flow is sequential for the operator and re-enterable for the same
 * reason the old page was: state lives on the page, not in the step. A
 * completed ingest can be revisited; a mapping mistake does not wipe the
 * name. The only hard gate is basics — the API refuses a campaign with no
 * name or an empty caller-ID pool, so later steps stay closed until those
 * two exist.
 */

export const BUILDER_STEP_IDS = [
  'basics',
  'contacts',
  'hours',
  'behaviour',
  'review',
] as const;

export type BuilderStepId = (typeof BUILDER_STEP_IDS)[number];

export interface BuilderStep {
  id: BuilderStepId;
  /** Full title on the step card. */
  title: string;
  /** Compact label in the stepper. */
  short: string;
  /** The one sentence the operator reads before acting. */
  helper: string;
}

export const BUILDER_STEPS: readonly BuilderStep[] = [
  {
    id: 'basics',
    title: 'Name & numbers',
    short: 'Basics',
    helper: 'Name this campaign and pick the numbers customers will see.',
  },
  {
    id: 'contacts',
    title: 'Who to call',
    short: 'Contacts',
    helper: 'Upload a CSV. Any columns are fine — you will say which one is the phone number next.',
  },
  {
    id: 'hours',
    title: 'When to call',
    short: 'Hours',
    helper: 'Set the hours this campaign is allowed to dial. Recommended hours are already filled in.',
  },
  {
    id: 'behaviour',
    title: 'How agents work',
    short: 'Agents',
    helper: 'Outcomes, retries and wrap-up. Recommended settings work for most campaigns — change them only if you need to.',
  },
  {
    id: 'review',
    title: 'Review & save',
    short: 'Review',
    helper: 'Check everything, then save. The campaign stays a draft until you start it.',
  },
];

export function stepIndex(id: BuilderStepId): number {
  return BUILDER_STEP_IDS.indexOf(id);
}

export function nextStep(id: BuilderStepId): BuilderStepId | null {
  const index = stepIndex(id);
  return index >= 0 && index < BUILDER_STEP_IDS.length - 1
    ? BUILDER_STEP_IDS[index + 1]!
    : null;
}

export function prevStep(id: BuilderStepId): BuilderStepId | null {
  const index = stepIndex(id);
  return index > 0 ? BUILDER_STEP_IDS[index - 1]! : null;
}

/**
 * Later steps stay closed until the campaign can actually be created.
 * Hours, behaviour and contacts all have safe defaults or are optional,
 * so once basics are ready every remaining step is a valid jump target.
 */
export function canVisitStep(id: BuilderStepId, basicsReady: boolean): boolean {
  return id === 'basics' || basicsReady;
}

export function basicsBlockReason(name: string, callerIds: readonly string[]): string | null {
  if (name.trim().length === 0) return 'Name the campaign first.';
  if (callerIds.length === 0) return 'Pick at least one number to call from.';
  return null;
}

/**
 * The page-level continue on the contacts step.
 *
 * `null` means hide it: upload/analyze/mapping/ingest already have their
 * own primary action, and a second "Continue" next to "Import contacts"
 * is how an operator skips the mapping they came here to do.
 */
export function contactsContinueLabel(phase: UploadPhase): string | null {
  if (
    phase === 'uploading' ||
    phase === 'analyzing' ||
    phase === 'mapping' ||
    phase === 'ingesting'
  ) {
    return null;
  }
  if (phase === 'done') return 'Continue';
  return 'Skip for now';
}

export function stepById(id: BuilderStepId): BuilderStep {
  return BUILDER_STEPS[stepIndex(id)]!;
}
