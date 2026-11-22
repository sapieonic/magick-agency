import type { TenantPhoneAssignment } from '../../../types/phone-number';
import { SERVICE_CARRIER, numberOnCarrier, type CarrierChoice } from '../../../utils/agencyCarriers';
import { SETUP_STEP_IDS, type SetupStepId } from '../../../utils/campaignSetup/setupSteps';

/**
 * The carrier account a new campaign starts on until the operator picks one: the first
 * listed (the service's own account comes first) that has a number available to this
 * account, so the caller-ID picker opens with something to pick. The first listed when
 * none has (or the numbers are not known yet), and the service's own account when the
 * list cannot be read, as before the choice existed.
 */
export function defaultBuilderCarrier<C extends CarrierChoice>(
  carriers: readonly C[] | null,
  numbers: readonly Pick<TenantPhoneAssignment, 'provider_name' | 'telephony_credential_id'>[] | null,
): CarrierChoice {
  if (!carriers || carriers.length === 0) return SERVICE_CARRIER;
  return carriers.find((c) => (numbers ?? []).some((n) => numberOnCarrier(n, c))) ?? carriers[0]!;
}

/**
 * The New campaign path over the four setup steps (CS1, `utils/campaignSetup/setupSteps.ts`).
 *
 * Sequential for the operator and re-enterable: state lives on the page, not in the step, so a
 * finished import can be revisited and a mapping mistake does not wipe the name. The only hard
 * gate is the basics: the API refuses a campaign with no name or an empty caller-ID pool, so the
 * later steps stay closed until those two exist.
 */

export function stepIndex(id: SetupStepId): number {
  return SETUP_STEP_IDS.indexOf(id);
}

export function nextStep(id: SetupStepId): SetupStepId | null {
  const index = stepIndex(id);
  return index >= 0 && index < SETUP_STEP_IDS.length - 1 ? SETUP_STEP_IDS[index + 1]! : null;
}

export function prevStep(id: SetupStepId): SetupStepId | null {
  const index = stepIndex(id);
  return index > 0 ? SETUP_STEP_IDS[index - 1]! : null;
}

/**
 * Later steps stay closed until the campaign can actually be created. Customers is optional and
 * the other two have working defaults, so once the basics are in every step can be opened.
 */
export function canVisitStep(id: SetupStepId, basicsReady: boolean): boolean {
  return id === 'basics' || basicsReady;
}

export function basicsBlockReason(name: string, callerIds: readonly string[]): string | null {
  if (name.trim().length === 0) return 'Name the campaign first.';
  if (callerIds.length === 0) return 'Pick at least one number to call from.';
  return null;
}
