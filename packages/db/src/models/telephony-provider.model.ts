/*
 * PORT NOTE (magick-agency): master `src/db/models/telephony-provider.model.ts`
 * @a1f0756a, trimmed to the baseline. Deleted: `live_transfer_enabled` (migration
 * 074, AI escalation; not a baseline column, so a `SELECT *` row never carries it)
 * and `CreateTelephonyProviderInput` / `UpdateTelephonyProviderInput` (their only
 * users were the repository's `create` / `update` and the super-admin
 * telephony-provider CRUD routes, all deleted: one seeded carrier, Decided #3).
 */
export interface TelephonyProviderRecord {
  id: string;
  name: string;
  display_name: string;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
}
