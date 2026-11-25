// Where a carrier's tenant-account numbers come from (docs/carriers.md §2.2, CR6), derived from
// its catalogue entry and its credential spec, never from its name:
//
//  - `sync`: its spec can list the numbers on a credential's account (`listNumbers`), so they
//    come only from the credential's "Sync numbers" and are never added by hand (Plivo);
//  - `manual`: the carrier has no such list, so a super-admin adds each number by hand, pinned to
//    one of the tenant's credentials (`POST /super-admin/phone-numbers` with
//    `telephony_credential_id`);
//  - null: the carrier takes no tenant accounts, so no number of it is pinned to a credential.
//
// Read by the super-admin number create and the provider reads (`GET /telephony-providers`,
// `GET /telephony-credential-providers`), so the console offers Sync or Add by the same rule the
// server applies.
import type { TelephonyNumberSource } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import { carrierTakesTenantAccounts } from './carrier-catalog.js';
import { findCredentialSpec } from './credentials/credential-specs.js';

export function carrierNumberSource(provider: string): TelephonyNumberSource | null {
  if (!carrierTakesTenantAccounts(provider)) return null;
  return findCredentialSpec(provider)?.listNumbers ? 'sync' : 'manual';
}
