/**
 * ─── AUTOMATIC OUTCOMES FOR UNANSWERED CALLS — THE SHARED RULES (OD2, OD3) ──
 *
 * A LEAF module, read by the server (the write-time validator and the dialer's stamp) and
 * the console (the campaign builder's editor and its validation), so the rule an operator
 * is shown and the rule the server enforces are one definition. Imports nothing beyond the
 * contracts' outcome list. Decisions OD1–OD8 (`docs/decisions.md`).
 */
import {
  AGENCY_AUTO_DISPOSITION_OUTCOMES,
  type AgencyAutoDispositionOutcome,
} from '@magick-agency/contracts/agency';

const MAPPABLE: ReadonlySet<string> = new Set(AGENCY_AUTO_DISPOSITION_OUTCOMES);

/** Is `value` an outcome a campaign may map (OD2)? */
export function isAutoDispositionOutcome(value: string): value is AgencyAutoDispositionOutcome {
  return MAPPABLE.has(value);
}

/** Why a code cannot be an automatic outcome, or null when it can. */
export type AutoDispositionRefusal = 'missing' | 'suppress' | 'terminal';

/**
 * Whether `code` may be an automatic outcome against `catalog` (OD3): it must name an
 * entry of the catalog (the FIRST with that code, as every catalog lookup reads it) that
 * neither `suppress`es nor is `terminal`. Those two claim a consequence an automatic
 * outcome never has: it is a label only, and the retry policy decides what happens to the
 * contact. Shape-safe on an untrusted catalog (a stored row, a request body).
 */
export function autoDispositionRefusal(catalog: unknown, code: string): AutoDispositionRefusal | null {
  const entries: unknown[] = Array.isArray(catalog) ? catalog : [];
  const entry = entries.find(
    (e): e is { suppress?: unknown; terminal?: unknown } =>
      !!e && typeof e === 'object' && (e as { code?: unknown }).code === code,
  );
  if (!entry) return 'missing';
  if (entry.suppress === true) return 'suppress';
  if (entry.terminal === true) return 'terminal';
  return null;
}
