/**
 * Copy shared by the operator screens that act on a tenant's carrier account: the refusal lookup
 * and the date-time format of the credential pages.
 */

/** The carrier refusals of the inbound actions (enable, re-point, link, unlink), by code. */
export const CARRIER_REFUSAL: Record<string, string> = {
  carrier_rejected: 'The carrier refused the stored credentials. Nothing was changed. Verify or rotate the secret, then try again.',
  carrier_unreachable: 'The carrier could not be reached. Nothing was changed. Try again shortly.',
  // docs/carriers.md CR11: the page hides inbound on such a carrier; a stale page can still ask.
  inbound_not_supported: 'This carrier does not take inbound calls here, so inbound cannot be set up on it. Nothing was changed.',
};

/**
 * What an operator reads for a failed action: the copy for the refusal's code when `copy` has
 * one, else the server's message, else `fallback`. The code is `details.code` (the phone-number
 * routes, beside an HTTP `error` name) or `details.error` (the credential routes).
 */
export function refusalCopy(err: unknown, copy: Record<string, string>, fallback: string): string {
  const details = (err as { details?: unknown } | null)?.details;
  if (details && typeof details === 'object') {
    const { code, error } = details as { code?: unknown; error?: unknown };
    for (const key of [code, error]) {
      if (typeof key === 'string' && Object.hasOwn(copy, key)) return copy[key]!;
    }
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A stored timestamp as the credential pages show it, or a dash when there is none. */
export const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : '—');
