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
  // There is no `is_byoc` flag: agency dials only on its own VoiceLink account,
  // never a tenant's own carrier account.
}
