/**
 * Copy shared by the operator screens that act on a tenant's carrier account: the refusal lookup
 * and the date-time format of the credential pages.
 */

/** The carrier refusals of the inbound actions (enable, re-point, link, unlink), by code. */
export const CARRIER_REFUSAL: Record<string, string> = {
  carrier_rejected: 'The carrier refused the stored credentials. Nothing was changed. Verify or rotate the secret, then try again.',
  carrier_unreachable: 'The carrier could not be reached. Nothing was changed. Try again shortly.',
};

/**
 * What an operator reads for a failed action: the copy for the refusal's code (`details.error`)
 * when `copy` has one, else the server's message, else `fallback`.
 */
export function refusalCopy(err: unknown, copy: Record<string, string>, fallback: string): string {
  const details = (err as { details?: unknown } | null)?.details;
  const code = details && typeof details === 'object' ? (details as { error?: unknown }).error : undefined;
  if (typeof code === 'string' && Object.hasOwn(copy, code)) return copy[code]!;
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A stored timestamp as the credential pages show it, or a dash when there is none. */
export const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : '—');
