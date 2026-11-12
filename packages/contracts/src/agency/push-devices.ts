/**
 * Mode B (IQ58–IQ74, `docs/inbound.md`, `docs/mobile.md` "The ring channel (Mode B)"): the agent
 * app's push devices, through which an away agent's phone is rung for an inbound caller, and the
 * data pushes the server sends them. Types and `as const` lists only, like the rest of this barrel.
 *
 * Stored in `agency_push_devices` (`0036_inbound_ring.sql`), one row per (agent, device): the
 * `device_id` is the app's station device id (`AgencyStationDevice.device_id`, OS3), so the device
 * that may be rung for a session is the one that holds its station (`station_device_id`, IQ60).
 * Push tokens are device addresses, not secrets: stored in plain text, never served back, never
 * logged.
 *
 * Routes (Firebase Bearer, the agent's own devices only), under `/proxy/agency/push-devices`:
 *
 * | Route | Body | Answer |
 * |---|---|---|
 * | `GET /:deviceId` | | {@link AgencyPushDeviceStatus} |
 * | `PUT /:deviceId` | {@link AgencyPushDevicePutRequest} | {@link AgencyPushDeviceStatus} |
 * | `PATCH /:deviceId` | {@link AgencyPushDevicePatchRequest} | {@link AgencyPushDeviceStatus} |
 * | `DELETE /:deviceId` | | 204 |
 * | `POST /:deviceId/test-ring` | | 202 (a `test_ring` push; one per 10 s) |
 *
 * `PATCH ring_enabled=false` and `DELETE` end this device's `away_ring` break ("Stop ringing").
 * Every list here that a column stores is held equal to its CHECK by
 * `packages/db/test/integration/db/inbound-ring-migration.test.ts`.
 */

import type { AllListed } from '../primitives';
import type { AgencyInboundRingResult } from './inbound';

/** The platform a push device runs (`agency_push_devices.platform`, CHECKed). iOS is contract-only for now (IQ64). */
export const AGENCY_PUSH_PLATFORMS = ['android', 'ios'] as const;
export type AgencyPushPlatform = (typeof AGENCY_PUSH_PLATFORMS)[number];

/**
 * Why the push sender could not deliver (`apps/server/src/seams/push-sender.ts`), and the
 * device's `last_failure_reason` (CHECKed):
 *
 *  - `unregistered`: the carrier says the token is gone (FCM `UNREGISTERED`, APNs 410); the device
 *    is revoked and its agent leaves `away_ring`;
 *  - `invalid`: the carrier refused the token or the message as malformed;
 *  - `rate_limited`: the carrier asked us to slow down;
 *  - `unavailable`: the carrier could not be reached, or answered a server error;
 *  - `unconfigured`: this deployment has no credentials for the platform.
 */
export const AGENCY_PUSH_FAILURE_REASONS = ['unregistered', 'invalid', 'rate_limited', 'unavailable', 'unconfigured'] as const;
export type AgencyPushFailureReason = (typeof AGENCY_PUSH_FAILURE_REASONS)[number];

/** One of the agent's push devices, as the routes serve it (never its tokens). */
export interface AgencyPushDevice {
  /** The app's station device id (OS3), the route's `:deviceId`. */
  device_id: string;
  platform: AgencyPushPlatform;
  /** A push address is registered for the platform (`fcm_token` on Android, `voip_token` on iOS). */
  push_registered: boolean;
  /** The app's build that last registered (`version+build`), for support. */
  app_build: string;
  /** The agent opted in to having this phone rung while away (default off). */
  ring_enabled: boolean;
  // ISO-8601 timestamps.
  /** The last register or heartbeat PUT. */
  last_seen_at: string;
  /** NULL while usable; set on DELETE or when the carrier reported the token unregistered. */
  revoked_at: string | null;
  /** The last failed send to it, and why; NULL when none since it last registered. */
  last_failure_at: string | null;
  last_failure_reason: AgencyPushFailureReason | null;
  created_at: string;
  updated_at: string;
}

/**
 * `PUT /push-devices/:deviceId`: register or refresh this device (on every open, a token change
 * and a resume). A revoked device is revived. `ring_enabled` left out keeps the stored value
 * (false on a new row). The token for the device's platform is required: `fcm_token` on Android,
 * `voip_token` on iOS.
 */
export interface AgencyPushDevicePutRequest {
  platform: AgencyPushPlatform;
  fcm_token?: string;
  voip_token?: string;
  app_build: string;
  ring_enabled?: boolean;
}

/** `PATCH /push-devices/:deviceId`: opt in or out. Off ends this device's `away_ring` ("Stop ringing"). */
export interface AgencyPushDevicePatchRequest {
  ring_enabled: boolean;
}

/** The answer to `GET`, `PUT` and `PATCH /push-devices/:deviceId`. */
export interface AgencyPushDeviceStatus {
  /** NULL when this device has no row (never registered). */
  device: AgencyPushDevice | null;
  /** `agency_inbound_ring_enabled` (and `agency_inbound_enabled`) are on for the agent's account: show the setting. */
  account_allows_ring: boolean;
  /** This deployment can send pushes to the device's platform (the push sender is configured). */
  push_configured: boolean;
}

/**
 * Why the server ended an away agent's ringing (`away_ring` → `device_away`, IQ67), the `reason`
 * of a `ring_off` push, which the app tells the agent:
 *
 *  - `ring_missed`: {@link AGENCY_INBOUND_RING_MAX_MISSES} missed rings in a row (IQ62);
 *  - `revoked`: the device was removed, or its token was reported unregistered;
 *  - `opted_out`: the agent turned ringing off ("Stop ringing");
 *  - `flag_off`: `agency_inbound_ring_enabled` was switched off for the account;
 *  - `max_age`: away longer than `AGENCY_AWAY_RING_MAX_MS` (server config);
 *  - `taken_over`: another device took the session's station over (OS3).
 */
export const AGENCY_RING_OFF_REASONS = ['ring_missed', 'revoked', 'opted_out', 'flag_off', 'max_age', 'taken_over'] as const;
export type AgencyRingOffReason = (typeof AGENCY_RING_OFF_REASONS)[number];

/**
 * The data push's `type`:
 *
 *  - `ring`: ring this phone for `call_id` until `ring_expires_at` (Android: a self-managed
 *    Telecom call and a full-screen CallStyle notification; iOS: a VoIP push and CallKit);
 *  - `ring_cancel`: stop ringing `call_id` (`reason`: its {@link AgencyInboundRingResult}). Android
 *    only: iOS never gets a VoIP push that is not a call, so it checks the call instead;
 *  - `ring_off`: the server ended this device's `away_ring` (`reason`: {@link AgencyRingOffReason});
 *    drop the "rings this phone" notification and say why on the next open;
 *  - `test_ring`: the settings card's "Send a test ring"; the phone rings locally, no call behind it.
 */
export const AGENCY_RING_PUSH_TYPES = ['ring', 'ring_cancel', 'ring_off', 'test_ring'] as const;
export type AgencyRingPushType = (typeof AGENCY_RING_PUSH_TYPES)[number];

/**
 * A ring push's data payload (FCM `data`, every value a string; an APNs VoIP payload's custom
 * keys). IQ61: never a name or a number. The app fetches the caller with `GET /inbound/calls/:id`
 * once it has accepted.
 */
export interface AgencyRingPush {
  type: AgencyRingPushType;
  /** `ring`, `ring_cancel`. */
  call_id?: string;
  /** `ring`: the token `…/ring/{answering,decline,accept}` take (IQ71). */
  offer_token?: string;
  /** `ring`: ISO-8601, when the ring expires on the server; the phone stops ringing then on its own. */
  ring_expires_at?: string;
  /** `ring`, `ring_off`: the campaign session it rings for. */
  session_id?: string;
  /** `ring_cancel`: an {@link AgencyInboundRingResult}; `ring_off`: an {@link AgencyRingOffReason}. */
  reason?: AgencyInboundRingResult | AgencyRingOffReason;
}

/**
 * Why `POST /sessions/:id/break {reason:'away_ring'}` was refused (409; the app falls back to
 * `device_away`):
 *
 *  - `ring_not_allowed`: ringing is off for the account (`agency_inbound_ring_enabled` or
 *    `agency_inbound_enabled`), or the session is not a campaign session;
 *  - `push_unavailable`: this deployment cannot send pushes to the device's platform;
 *  - `no_push_device`: the session's station device has no usable push registration (none, revoked,
 *    or no token);
 *  - `ring_disabled`: the device is registered but the agent has not turned ringing on.
 */
export type AgencyAwayRingRefusalCode = 'ring_not_allowed' | 'push_unavailable' | 'no_push_device' | 'ring_disabled';

/** Runtime list of {@link AgencyAwayRingRefusalCode}, in declaration order. */
export const AGENCY_AWAY_RING_REFUSAL_CODES = [
  'ring_not_allowed',
  'push_unavailable',
  'no_push_device',
  'ring_disabled',
] as const satisfies readonly AgencyAwayRingRefusalCode[];

const _allAwayRingCodesListed: AllListed<AgencyAwayRingRefusalCode, typeof AGENCY_AWAY_RING_REFUSAL_CODES> = true;
void _allAwayRingCodesListed;

/** The 409 body of an away-ring refusal. */
export interface AgencyAwayRingRefusal {
  error: 'Conflict';
  code: AgencyAwayRingRefusalCode;
  /** English fallback copy; the app words each code itself. */
  message: string;
}
