/**
 * Only `TenantPhoneAssignment` lives here — the row `GET /phone-numbers` returns
 * and the campaign builder's caller-ID picker reads. The provider and inventory
 * shapes (`TelephonyProvider`, `PhoneNumber`) belong to super-admin.
 */

export interface TenantPhoneAssignment {
  id: string;
  phone_number: string;
  phone_number_id: string;
  provider_name: string;
  provider_display_name: string;
  /**
   * The tenant carrier credential the number was synced from (`GET /phone-numbers`
   * sends it), or null for the service's own account. Optional: older servers omit it.
   */
  telephony_credential_id?: string | null;
  label: string | null;
  is_default: boolean;
  max_concurrent_calls: number;
  capabilities: string[];
  region: string | null;
  account_tags?: Array<{
    account_id: string;
    account_name: string;
    is_default: boolean;
  }>;
  // There is no `is_byoc` flag: a number on the tenant's own carrier account is the one
  // with a non-null `telephony_credential_id`.
}
