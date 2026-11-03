import { AGENCY_REDIALED_DISPOSITION_CODE } from '../../types/agency';

/**
 * Disposition codes the SYSTEM writes, never an agent, and never in a campaign's
 * catalog: today only `redialed`, which a wrap-up redial stamps on the call it
 * redials (the outcome itself is filed on the redial).
 *
 * No catalog carries a label for them, so without this every view that resolves a
 * disposition through the catalog fell back to the raw code — a supervisor read
 * `redialed` beside "Sale" and "No interest", a wire value passed off as an
 * outcome. Every such view asks here first, the way break labels ask
 * `reservedBreakReasonLabel` first, and styles the value as the system's.
 */
export const SYSTEM_DISPOSITION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [AGENCY_REDIALED_DISPOSITION_CODE]: 'Redialled',
});

/** What writes each, as the campaign builder's refusal states it. */
const SYSTEM_DISPOSITION_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  [AGENCY_REDIALED_DISPOSITION_CODE]: 'the system writes it on a call the agent redialled from wrap-up',
});

/** What wrote it, for a tooltip or a hint beside the label. */
export const SYSTEM_DISPOSITION_HINTS: Readonly<Record<string, string>> = Object.freeze({
  [AGENCY_REDIALED_DISPOSITION_CODE]:
    'Closed when the agent redialled the customer from wrap-up. The outcome is on the redial.',
});

export function isSystemDispositionCode(code: string | null | undefined): code is string {
  return !!code && Object.prototype.hasOwnProperty.call(SYSTEM_DISPOSITION_LABELS, code);
}

/** The label of a system-written code, or null for any other code. */
export function systemDispositionLabel(code: string | null | undefined): string | null {
  return isSystemDispositionCode(code) ? SYSTEM_DISPOSITION_LABELS[code]! : null;
}

/**
 * The campaign builder's refusal for a catalog entry using a system code, or null.
 * The server refuses the same codes on save; refusing them here puts the finding
 * on the field before the round trip.
 */
export function reservedDispositionCodeMessage(code: string): string | null {
  const owner = isSystemDispositionCode(code) ? SYSTEM_DISPOSITION_OWNERS[code] : undefined;
  return owner ? `‘${code}’ is reserved: ${owner}. Choose another code.` : null;
}
