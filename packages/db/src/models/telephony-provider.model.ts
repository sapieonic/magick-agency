/*
 * Matches the baseline. There is no `live_transfer_enabled` (AI escalation; not a
 * baseline column, so a `SELECT *` row never carries it) and no create/update
 * input types: the carrier is seeded, with no telephony-provider CRUD routes
 * (one seeded carrier).
 */
export interface TelephonyProviderRecord {
  id: string;
  name: string;
  display_name: string;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
}
