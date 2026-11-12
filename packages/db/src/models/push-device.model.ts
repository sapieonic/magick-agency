/*
 * `agency_push_devices` (0036_inbound_ring.sql; Mode B, IQ58–IQ74): the agent app's push devices,
 * one row per (agent, station device id). A `SELECT *` row. The repository and its inputs are
 * WP2's; this is the row shape they and the ring's eligibility read build on.
 *
 * The tokens are device addresses, not secrets, but are never served back (the wire shape,
 * `AgencyPushDevice`, says only `push_registered`) and never logged.
 */
import type { AgencyPushFailureReason, AgencyPushPlatform } from '@magick-agency/contracts/agency';

export interface PushDeviceRecord {
  id: string;
  /** The tenant the device last registered from; scopes nothing the ring reads (an agent's phone is one phone across tenants, OS1). */
  tenant_id: string;
  user_id: string;
  /** The app's station device id (OS3): matched against `agency_agent_sessions.station_device_id`. */
  device_id: string;
  platform: AgencyPushPlatform;
  /** Android (FCM). */
  fcm_token: string | null;
  /** iOS (PushKit VoIP). */
  voip_token: string | null;
  app_build: string;
  ring_enabled: boolean;
  last_seen_at: Date;
  revoked_at: Date | null;
  /** Both or neither (`ck_agency_push_devices_failure`). */
  last_failure_at: Date | null;
  last_failure_reason: AgencyPushFailureReason | null;
  created_at: Date;
  updated_at: Date;
}

/** The token a send to `device` uses: `fcm_token` on Android, `voip_token` on iOS; null when none. */
export function pushTokenOf(device: Pick<PushDeviceRecord, 'platform' | 'fcm_token' | 'voip_token'>): string | null {
  return device.platform === 'android' ? device.fcm_token : device.voip_token;
}
