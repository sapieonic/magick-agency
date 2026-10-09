/**
 * PORT NOTE (magick-agency): of cusui's `src/types/phone-number.ts` @ ee5beb44
 * only `TenantPhoneAssignment` is ported — the row `GET /phone-numbers` returns
 * and the campaign builder's caller-ID picker reads. The provider and inventory
 * shapes (`TelephonyProvider`, `PhoneNumber`) belong to super-admin, and the
 * inbound-configuration shapes to the AI product.
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
  // PORT NOTE (magick-agency): cusui's optional `is_byoc` (a number on the
  // tenant's own carrier account) is removed — BYOC is not ported, agency dials
  // only on its own VoiceLink account (extraction plan §1, §9).
}
