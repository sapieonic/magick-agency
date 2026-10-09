import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import type { AccountRecord } from '@magick-agency/db/models/account.model';
import type { AccountSettingsRecord } from '@magick-agency/db/models/account-settings.model';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';
import type {
  AgencyAccountSettings,
  AgencyAccountSettingsMap,
} from '@magick-agency/contracts/api/platform/settings';

/**
 * The per-account settings row as the wire sees it — EFFECTIVE values, so every field is non-null
 * (`@magick-agency/contracts/api/platform/settings`, "Values are EFFECTIVE
 * values").
 *
 * ── What `null` in the row resolves to, and why ────────────────────────────
 *  - `allow_recording` → `false`. Off by default, because this dials real people
 *    at volume. The per-field campaign-write assert reads this value, so the null
 *    case must be the safe direction. NOTE: the baseline column comment says the
 *    call-start default for a NULL is `true`; that is the WebRTC bridge's concern
 *    at call time, and a campaign can only ask for recording when this resolves
 *    `true`.
 *  - `analyze_calls` → `false`, for the same reason.
 *  - `max_concurrent_calls` → the row's value, or 5 when there is no row — the
 *    column default.
 *  - `webrtc_max_duration_seconds` → 1800, valid range 60..14400.
 *  - `updated_at` → the row's, or the account's own `updated_at` when the account
 *    has never had a settings row (nothing about its settings has changed since).
 */
export const DEFAULT_ALLOW_RECORDING = false;
export const DEFAULT_ANALYZE_CALLS = false;
export const DEFAULT_MAX_CONCURRENT_CALLS = 5;
export const DEFAULT_WEBRTC_MAX_DURATION_SECONDS = 1800;
/** The valid range of `webrtc_max_duration_seconds`. */
export const WEBRTC_MAX_DURATION_MIN_SECONDS = 60;
export const WEBRTC_MAX_DURATION_MAX_SECONDS = 14_400;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toAgencyAccountSettings(
  tenantId: string,
  account: Pick<AccountRecord, 'id' | 'updated_at'>,
  row: AccountSettingsRecord | null,
): AgencyAccountSettings {
  return {
    tenant_id: tenantId,
    account_id: account.id,
    allow_recording: row?.allow_recording ?? DEFAULT_ALLOW_RECORDING,
    analyze_calls: row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS,
    max_concurrent_calls: row?.max_concurrent_calls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    webrtc_max_duration_seconds: row?.webrtc_max_duration_seconds ?? DEFAULT_WEBRTC_MAX_DURATION_SECONDS,
    updated_at: iso(row?.updated_at ?? account.updated_at),
  };
}

/** The effective settings for one account. */
export async function loadAgencyAccountSettings(
  tenantId: string,
  account: Pick<AccountRecord, 'id' | 'updated_at'>,
): Promise<AgencyAccountSettings> {
  const row = await accountSettingsRepository.findByTenantAndAccount(tenantId, account.id);
  return toAgencyAccountSettings(tenantId, account, row);
}

/**
 * The session payload's `settings` map: one entry per account the caller's
 * ACTIVE memberships reach, keyed by `account_id` (lead decision Q3a) — every
 * live account in the tenant for a tenant-wide membership (`account_id IS NULL`),
 * else just the membership's account. Two reads per tenant (accounts, settings
 * rows), never one per account.
 */
export async function buildAgencyAccountSettingsMap(
  memberships: Array<Pick<MembershipRecord, 'tenant_id' | 'account_id' | 'status'>>,
): Promise<AgencyAccountSettingsMap> {
  const byTenant = new Map<string, { tenantWide: boolean; accountIds: Set<string> }>();
  for (const m of memberships) {
    if (m.status !== 'active') continue;
    const entry = byTenant.get(m.tenant_id) ?? { tenantWide: false, accountIds: new Set<string>() };
    if (m.account_id === null) entry.tenantWide = true;
    else entry.accountIds.add(m.account_id);
    byTenant.set(m.tenant_id, entry);
  }

  const map: AgencyAccountSettingsMap = {};
  for (const [tenantId, reach] of byTenant) {
    const [accounts, rows] = await Promise.all([
      reach.tenantWide
        ? accountRepository.findByTenantId(tenantId)
        : accountRepository.findByIds([...reach.accountIds], tenantId),
      accountSettingsRepository.listByTenant(tenantId),
    ]);
    const rowByAccount = new Map(rows.map((r) => [r.account_id, r]));
    for (const account of accounts) {
      map[account.id] = toAgencyAccountSettings(tenantId, account, rowByAccount.get(account.id) ?? null);
    }
  }
  return map;
}
