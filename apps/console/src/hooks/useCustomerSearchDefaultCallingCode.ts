import { useEffect, useState } from 'react';
import { getCustomerSearchOptions } from '../api/customerHistory';
import { useTenant } from '../contexts/TenantContext';

/**
 * The calling code the customer-search country picker starts on: the platform's
 * `DEFAULT_PHONE_COUNTRY_CODE`, read once per page load from
 * `GET /proxy/agency/customers/options` (`docs/customer-history.md` CH5).
 *
 * Never blocks typing: until the answer arrives, and if it never does (an error,
 * an older server), the picker uses {@link FALLBACK_SEARCH_CALLING_CODE}, the same
 * value the server falls back to. The answer is a platform setting, the same for
 * every tenant and user, so one successful read serves the whole session. A failed
 * read is NOT kept: a network blip, a 429, a 5xx or a 403 (the first account with
 * the dialer off) would otherwise pin +91 until a reload; the next box to mount
 * reads it again, as the agent app does when its search box opens.
 */

/** `+91`: the platform's own default when nothing else says otherwise. */
export const FALLBACK_SEARCH_CALLING_CODE = '+91';

const CALLING_CODE = /^\+?\d{1,4}$/;

let cached: string | null = null;
let pending: Promise<string> | null = null;

/**
 * The default calling code (`+91` form), fetched once per session once a read succeeds;
 * resolves to the fallback on any failure, and forgets the failure, so the next call reads again.
 */
export function loadCustomerSearchDefaultCallingCode(tenantId?: string, accountId?: string): Promise<string> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const read: Promise<string> = Promise.resolve()
    .then(() => getCustomerSearchOptions(tenantId, accountId))
    .then(
      (options) => {
        const code = options?.default_country_code;
        cached = typeof code === 'string' && CALLING_CODE.test(code) ? code : FALLBACK_SEARCH_CALLING_CODE;
        return cached;
      },
      () => {
        // Not cached: the next box to mount asks again.
        if (pending === read) pending = null;
        return FALLBACK_SEARCH_CALLING_CODE;
      },
    );
  pending = read;
  return read;
}

/** Tests only: forget the session's answer. */
export function resetCustomerSearchDefaultCallingCode(): void {
  cached = null;
  pending = null;
}

/** The default calling code; nothing is read while `enabled` is false (a reader who may not search numbers). */
export function useCustomerSearchDefaultCallingCode(enabled = true): string {
  const { tenantId, accountId } = useTenant();
  const [code, setCode] = useState(() => cached ?? FALLBACK_SEARCH_CALLING_CODE);

  useEffect(() => {
    if (!enabled) return undefined;
    if (cached) {
      setCode(cached);
      return undefined;
    }
    let live = true;
    void loadCustomerSearchDefaultCallingCode(tenantId ?? undefined, accountId ?? undefined).then((value) => {
      if (live) setCode(value);
    });
    return () => {
      live = false;
    };
  }, [enabled, tenantId, accountId]);

  return code;
}
