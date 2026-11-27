/*
 * An account's two media grants, from its settings row: `allow_recording` (`agency.recording`)
 * and `analyze_calls` (`agency.analytics`). Read by the soft phone's routes for the request's
 * account and by the campaign call export (`docs/call-log.md` §10, CL47) for the campaign's.
 */
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { DEFAULT_ALLOW_RECORDING, DEFAULT_ANALYZE_CALLS } from '../../../settings/agency-account-settings.js';

export interface AccountMediaGrants {
  recording: boolean;
  analytics: boolean;
}

/**
 * The account's grants: each `true` only when its column says so (NULL / no row = the documented
 * default). **Any failure is nothing granted** (fail closed): `onError` is told, and the caller
 * answers as it would for an account with both off.
 */
export async function readAccountMediaGrants(
  tenantId: string,
  accountId: string,
  onError: (err: unknown) => void,
): Promise<AccountMediaGrants> {
  try {
    const row = await accountSettingsRepository.findByTenantAndAccount(tenantId, accountId);
    return {
      recording: (row?.allow_recording ?? DEFAULT_ALLOW_RECORDING) === true,
      analytics: (row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS) === true,
    };
  } catch (err) {
    onError(err);
    return { recording: false, analytics: false };
  }
}
