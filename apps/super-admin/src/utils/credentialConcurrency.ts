/**
 * A tenant carrier account's own concurrency cap in the console (docs/carriers.md CR13): the
 * most calls live at once on that account, across every account of the tenant. Null is no cap
 * of its own; the service and account limits apply either way.
 */
import { TELEPHONY_CREDENTIAL_MAX_CONCURRENT_CALLS } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

/** What a credential's own cap reads as, with the calls it counts now when the server could read them. */
export function concurrencyLimitText(cap: number | null, inUse: number | undefined | null): string {
  if (cap === null) return 'No limit of its own';
  return inUse === undefined || inUse === null ? `Up to ${cap}` : `${inUse} of ${cap} in use`;
}

/** The help under every "Concurrent calls" field. */
export const CONCURRENCY_HELP = 'The most calls that can be live at once on this carrier account, across all of the tenant’s '
  + 'accounts. Leave it empty for no limit of its own; the service and account limits still apply.';

/**
 * A "Concurrent calls" field's text as the cap to send: null when empty, else a whole number from
 * 1 to the bound, or a message saying what is wrong.
 */
export function parseConcurrencyLimit(text: string): { cap: number | null } | { error: string } {
  const t = text.trim();
  if (t === '') return { cap: null };
  if (!/^\d+$/.test(t)) return { error: 'Enter a whole number of calls, or leave it empty for no limit.' };
  const n = Number(t);
  if (n < 1 || n > TELEPHONY_CREDENTIAL_MAX_CONCURRENT_CALLS) {
    return { error: `Enter a number from 1 to ${TELEPHONY_CREDENTIAL_MAX_CONCURRENT_CALLS.toLocaleString('en-IN')}, or leave it empty for no limit.` };
  }
  return { cap: n };
}
