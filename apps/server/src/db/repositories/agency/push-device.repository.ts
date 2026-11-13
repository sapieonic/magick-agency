/**
 * `AgencyPushDeviceRepository`: `agency_push_devices` (0036; Mode B, IQ58–IQ74), the agent app's
 * push devices, one row per (agent, station device id). The routes
 * (`api/routes/agency/push-devices.ts`), the away-ring service (`agency/away-ring.ts`) and the
 * inbound connector's ring read and write it.
 *
 * Tokens are device addresses, not secrets: stored in plain text, never served back (the wire
 * shape says only `push_registered`, {@link toWirePushDevice}) and never logged. Every method here
 * is keyed on the user: an agent reaches only their own devices.
 */
import { getPool } from '@magick-agency/db';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { pushTokenOf, type PushDeviceRecord } from '@magick-agency/db/models/push-device.model';
import type {
  AgencyPushDevice,
  AgencyPushFailureReason,
  AgencyPushPlatform,
} from '@magick-agency/contracts/agency';

/** A register (`PUT /push-devices/:deviceId`), as the route validated it. */
export interface PushDeviceRegisterInput {
  tenantId: string;
  userId: string;
  deviceId: string;
  platform: AgencyPushPlatform;
  /** The token for `platform` (`fcm_token` on Android, `voip_token` on iOS); the other is cleared. */
  token: string;
  appBuild: string;
  /** Left out: the stored value is kept (false on a new row). */
  ringEnabled?: boolean;
}

/** How many times a register retries when another register took the same token in between. */
const REGISTER_ATTEMPTS = 3;

/** The wire shape of a device row: never its tokens. */
export function toWirePushDevice(row: PushDeviceRecord): AgencyPushDevice {
  return {
    device_id: row.device_id,
    platform: row.platform,
    push_registered: pushTokenOf(row) !== null,
    app_build: row.app_build,
    ring_enabled: row.ring_enabled,
    last_seen_at: row.last_seen_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    last_failure_at: row.last_failure_at ? row.last_failure_at.toISOString() : null,
    last_failure_reason: row.last_failure_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Whether a device can be rung: registered, not revoked, opted in, with a token for its platform. */
export function pushDeviceRingable(row: PushDeviceRecord | null): boolean {
  return !!row && row.revoked_at === null && row.ring_enabled && pushTokenOf(row) !== null;
}

export class AgencyPushDeviceRepository {
  /** The agent's own device, revoked or not; null when it never registered. */
  async find(userId: string, deviceId: string): Promise<PushDeviceRecord | null> {
    const { rows } = await getPool().query<PushDeviceRecord>(
      'SELECT * FROM agency_push_devices WHERE user_id = $1 AND device_id = $2',
      [userId, deviceId],
    );
    return rows[0] ?? null;
  }

  /**
   * Register or refresh this device (`PUT`): upserted on `(user_id, device_id)`. A revoked row is
   * revived, the last failure cleared (it is "since it last registered"), `last_seen_at` and the
   * tenant restamped, and `ring_enabled` written only when given.
   *
   * One live row per push address (`uq_agency_push_devices_fcm_token` / `_voip_token`): any OTHER
   * live row holding this token (the phone reinstalled under a new device id, or another agent who
   * signed in on it before) is revoked first, in the same transaction, so one phone is never rung
   * for two rows. Two registers racing for one token: the loser's insert trips the index and the
   * whole transaction is tried again.
   */
  async register(input: PushDeviceRegisterInput): Promise<PushDeviceRecord> {
    const fcm = input.platform === 'android' ? input.token : null;
    const voip = input.platform === 'ios' ? input.token : null;
    const tokenColumn = input.platform === 'android' ? 'fcm_token' : 'voip_token';
    for (let attempt = 1; ; attempt++) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE agency_push_devices
              SET revoked_at = now()
            WHERE ${tokenColumn} = $1 AND revoked_at IS NULL
              AND NOT (user_id = $2 AND device_id = $3)`,
          [input.token, input.userId, input.deviceId],
        );
        const { rows } = await client.query<PushDeviceRecord>(
          `INSERT INTO agency_push_devices
             (tenant_id, user_id, device_id, platform, fcm_token, voip_token, app_build, ring_enabled, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::boolean, false), now())
           ON CONFLICT (user_id, device_id) DO UPDATE
             SET tenant_id = EXCLUDED.tenant_id,
                 platform = EXCLUDED.platform,
                 fcm_token = EXCLUDED.fcm_token,
                 voip_token = EXCLUDED.voip_token,
                 app_build = EXCLUDED.app_build,
                 ring_enabled = COALESCE($8::boolean, agency_push_devices.ring_enabled),
                 last_seen_at = now(),
                 revoked_at = NULL,
                 last_failure_at = NULL,
                 last_failure_reason = NULL
           RETURNING *`,
          [input.tenantId, input.userId, input.deviceId, input.platform, fcm, voip, input.appBuild,
            input.ringEnabled ?? null],
        );
        await client.query('COMMIT');
        return rows[0]!;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const tokenRace = isUniqueViolation(err, 'uq_agency_push_devices_fcm_token')
          || isUniqueViolation(err, 'uq_agency_push_devices_voip_token');
        if (!tokenRace || attempt >= REGISTER_ATTEMPTS) throw err;
      } finally {
        client.release();
      }
    }
  }

  /**
   * Opt in or out (`PATCH`). Only a live (not revoked) row: a revoked device is registered again
   * first. Null when there is no live row.
   */
  async setRingEnabled(userId: string, deviceId: string, ringEnabled: boolean): Promise<PushDeviceRecord | null> {
    const { rows } = await getPool().query<PushDeviceRecord>(
      `UPDATE agency_push_devices SET ring_enabled = $3
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
        RETURNING *`,
      [userId, deviceId, ringEnabled],
    );
    return rows[0] ?? null;
  }

  /**
   * Revoke the device (`DELETE`, sign-out): the row stays (its tokens with it, so a `ring_off` can
   * still reach the phone), never rung again until it registers. Returns the row as it was before
   * (null when there is none, or it was already revoked: idempotent).
   */
  async revoke(userId: string, deviceId: string): Promise<PushDeviceRecord | null> {
    const { rows } = await getPool().query<PushDeviceRecord>(
      `UPDATE agency_push_devices SET revoked_at = now()
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
        RETURNING *`,
      [userId, deviceId],
    );
    return rows[0] ?? null;
  }

  /**
   * A send to the device failed (`AgencyPushFailureReason`): the failure recorded, and a token the
   * carrier refused for good (`unregistered`: FCM `UNREGISTERED`, APNs 410; `invalid`: FCM
   * `SENDER_ID_MISMATCH` or a malformed token, APNs `DeviceTokenNotForTopic`; `pushFailureRevokes`)
   * revokes the row, so it is never rung again until the app registers a new token. Keyed on the
   * row id, as the sender knows it. Returns whether this write revoked it.
   */
  async recordFailure(id: string, reason: AgencyPushFailureReason): Promise<{ revoked: boolean }> {
    const { rows } = await getPool().query<{ revoked: boolean }>(
      `UPDATE agency_push_devices d
          SET last_failure_at = now(),
              last_failure_reason = $2::varchar,
              revoked_at = CASE WHEN $2::varchar IN ('unregistered', 'invalid') THEN COALESCE(d.revoked_at, now()) ELSE d.revoked_at END
         FROM (SELECT id, revoked_at FROM agency_push_devices WHERE id = $1 FOR UPDATE) prev
        WHERE d.id = prev.id
        RETURNING ($2::varchar IN ('unregistered', 'invalid') AND prev.revoked_at IS NULL) AS revoked`,
      [id, reason],
    );
    return { revoked: rows[0]?.revoked ?? false };
  }

  /**
   * The push device that holds a session's station (IQ60): the agent's row for the session's
   * `station_device_id`, revoked or not; null when the session names no device or it never
   * registered.
   */
  async findForSession(sessionId: string): Promise<PushDeviceRecord | null> {
    const { rows } = await getPool().query<PushDeviceRecord>(
      `SELECT d.* FROM agency_agent_sessions s
         JOIN agency_push_devices d ON d.user_id = s.agent_user_id AND d.device_id = s.station_device_id
        WHERE s.id = $1`,
      [sessionId],
    );
    return rows[0] ?? null;
  }
}

export const agencyPushDeviceRepository = new AgencyPushDeviceRepository();
