/*
 * The agent app's push devices (Mode B, IQ58–IQ74; `@magick-agency/contracts/agency`
 * `push-devices.ts`): the internal handlers behind `/proxy/agency/push-devices/:deviceId`
 * (`proxy-agency-push-devices.routes.ts`, which adds the session, the RBAC floor, the actor, the
 * rate limit on the test ring and the audit rows). Part of `agency.routes.ts`.
 *
 * Own devices only: every handler is keyed on the acting user (`agent_user_id` in the body,
 * `actor_user_id` in a GET or DELETE query), never a user named by the client, and a device is
 * one row per (user, device id). The tokens are never answered or logged.
 *
 *  - `GET /push-devices/:id`: the device's status (`AgencyPushDeviceStatus`).
 *  - `PUT /push-devices/:id`: register or refresh it; a revoked row is revived.
 *  - `PATCH /push-devices/:id`: opt in or out; off (the opt-out, the Me toggle) ends this device's `away_ring`.
 *  - `DELETE /push-devices/:id`: revoke it (sign-out); ends this device's `away_ring`. 204.
 *  - `POST /push-devices/:id/test-ring`: a `test_ring` push through the sender. 202.
 *
 * The answers to PUT, PATCH and DELETE carry {@link PUSH_DEVICE_AUDIT_KEY} for the public layer's
 * audit row, taken off before the client sees them ({@link takePushDeviceAudit}).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_PUSH_PLATFORMS,
  AGENCY_STATION_DEVICE_ID_PATTERN,
  type AgencyPushDeviceStatus,
  type AgencyPushPlatform,
} from '@magick-agency/contracts/agency';
import { pushTokenOf, type PushDeviceRecord } from '@magick-agency/db/models/push-device.model';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { agencyPushDeviceRepository, toWirePushDevice } from '../../../db/repositories/agency.repository.js';
import { getPushSender, pushFailureRevokes } from '../../../seams/push-sender.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { awayRingRefusalBody, TEST_RING_PUSH_TTL_MS } from '../../../agency/away-ring.js';
import { takeAuditMarker } from '../helpers/audit-marker.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
import { sendRefusal } from '../helpers/refusal.js';
import { UUID_RE } from '../../../utils/uuid.js';
import type { AuditActorFields } from '../../../audit/platform/audit-actor.js';

const log = createChildLogger({ component: 'agency-push-device-routes' });

/** A push token's ceiling: FCM tokens are about 160 characters, APNs ones 64 hex; this is generous. */
const PUSH_TOKEN_MAX = 4096;

/** The internal answer's audit marker, taken off by the public layer. */
export const PUSH_DEVICE_AUDIT_KEY = 'push_device_audit';

/** What the public layer audits for a PUT, PATCH or DELETE (ids only, never a token). */
export interface PushDeviceAudit {
  /** `agency_push_devices.id`. */
  id: string;
  device_id: string;
  /** Set when the call changed the opt-in: its new value. */
  ring_enabled_changed?: boolean;
  /** Set when the call revoked the device. */
  revoked?: true;
}

/** Remove the audit marker from an internal answer (mutating it); the marker, when there was one. */
export function takePushDeviceAudit(body: unknown): PushDeviceAudit | null {
  return takeAuditMarker<PushDeviceAudit>(body, PUSH_DEVICE_AUDIT_KEY);
}

export const pushDevicePutSchema = z.object({
  platform: z.enum(AGENCY_PUSH_PLATFORMS),
  fcm_token: z.string().trim().min(1).max(PUSH_TOKEN_MAX).optional(),
  voip_token: z.string().trim().min(1).max(PUSH_TOKEN_MAX).optional(),
  app_build: z.string().trim().min(1).max(64),
  ring_enabled: z.boolean().optional(),
}).superRefine((body, ctx) => {
  const token = body.platform === 'android' ? body.fcm_token : body.voip_token;
  if (!token) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [body.platform === 'android' ? 'fcm_token' : 'voip_token'],
      message: body.platform === 'android' ? 'fcm_token is required on Android' : 'voip_token is required on iOS',
    });
  }
});

export const pushDevicePatchSchema = z.object({ ring_enabled: z.boolean() });

/** The device id in the path: the app's station device id (OS3's pattern). */
export function isPushDeviceId(value: unknown): value is string {
  return typeof value === 'string' && AGENCY_STATION_DEVICE_ID_PATTERN.test(value);
}

interface PushActor {
  tenantId: string;
  accountId: string | undefined;
  userId: string;
}

function actorFrom(request: FastifyRequest, reply: FastifyReply, source: 'body' | 'query'): PushActor | null {
  const raw = source === 'body'
    ? ((request.body ?? {}) as { agent_user_id?: unknown }).agent_user_id
    : ((request.query ?? {}) as { actor_user_id?: unknown }).actor_user_id;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    sendRefusal(reply, 400, 'missing_actor', 'The request did not identify which agent is acting.');
    return null;
  }
  return { tenantId: getTenantId(request), accountId: getAccountId(request) || undefined, userId: raw };
}

/**
 * The path's device id, or null with the 404 sent (a malformed id is answered as an unknown
 * device). Both layers use it: the public routes (`proxy-agency-push-devices.routes.ts`) and these.
 */
export function pushDeviceIdOr404(raw: unknown, reply: FastifyReply): string | null {
  if (isPushDeviceId(raw)) return raw;
  void reply.code(404).send({ error: 'Not Found', message: 'No such device.' });
  return null;
}

function deviceIdOr404(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null {
  return pushDeviceIdOr404(request.params.id, reply);
}

/**
 * End this device's `away_ring` after a write that already took effect (opt-out, revoke). Never
 * fails the request: the change is committed, and an absence left running is ended by the next
 * reconcile, which finds the device opted out or revoked (N1).
 */
async function endAwayRingForDevice(
  runtime: AgencyRuntime,
  agentUserId: string,
  deviceId: string,
  reason: 'opted_out' | 'revoked',
  actor?: AuditActorFields,
): Promise<void> {
  await runtime.awayRing.endForDevice(agentUserId, deviceId, reason, actor).catch((err: unknown) => {
    log.warn({ err, agentUserId, deviceId, reason }, 'Could not end the device\'s away-ring; the reconcile ends it');
  });
}

async function statusOf(runtime: AgencyRuntime, actor: PushActor, device: PushDeviceRecord | null, platform?: AgencyPushPlatform): Promise<AgencyPushDeviceStatus> {
  const accountAllowsRing = actor.accountId ? await runtime.awayRing.ringAllowed(actor.tenantId, actor.accountId) : false;
  return {
    device: device ? toWirePushDevice(device) : null,
    account_allows_ring: accountAllowsRing,
    push_configured: getPushSender().configured(device?.platform ?? platform ?? 'android'),
  };
}

export async function registerPushDeviceRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── GET /push-devices/:id ─────────────────────────────────────────────
  sub.get('/push-devices/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const actor = actorFrom(request, reply, 'query');
    if (!actor) return reply;
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const device = await agencyPushDeviceRepository.find(actor.userId, deviceId);
    return reply.send(await statusOf(runtime, actor, device));
  });

  // ── PUT /push-devices/:id — register or refresh ────────────────────────
  sub.put('/push-devices/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const actor = actorFrom(request, reply, 'body');
    if (!actor) return reply;
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const parsed = pushDevicePutSchema.safeParse(request.body);
    if (!parsed.success) {
      return replyValidationFailed(reply, parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;
    const device = await agencyPushDeviceRepository.register({
      tenantId: actor.tenantId,
      userId: actor.userId,
      deviceId,
      platform: body.platform,
      token: (body.platform === 'android' ? body.fcm_token : body.voip_token)!,
      appBuild: body.app_build,
      ...(body.ring_enabled !== undefined ? { ringEnabled: body.ring_enabled } : {}),
    });
    const changed = (device.prev_ring_enabled ?? false) !== device.ring_enabled;
    // A register that turns ringing off ends this device's `away_ring`, as the PATCH does.
    if (changed && !device.ring_enabled) await endAwayRingForDevice(runtime, actor.userId, deviceId, 'opted_out');
    const audit: PushDeviceAudit = {
      id: device.id, device_id: deviceId, ...(changed ? { ring_enabled_changed: device.ring_enabled } : {}),
    };
    return reply.send({ ...(await statusOf(runtime, actor, device)), [PUSH_DEVICE_AUDIT_KEY]: audit });
  });

  // ── PATCH /push-devices/:id — opt in or out (the Me toggle) ─────────────
  sub.patch('/push-devices/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const actor = actorFrom(request, reply, 'body');
    if (!actor) return reply;
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const parsed = pushDevicePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return replyValidationFailed(reply, { ring_enabled: 'required: true or false' });
    }
    const device = await agencyPushDeviceRepository.setRingEnabled(actor.userId, deviceId, parsed.data.ring_enabled);
    if (!device) return reply.code(404).send({ error: 'Not Found', message: 'This phone is not registered. Open the app on it first.' });
    // The opt-out (the Me toggle): this device's `away_ring` ends now (`device_away`, `ring_off`). A ring in
    // flight is the connector's; the reconcile ends the absence after it.
    if (!device.ring_enabled) await endAwayRingForDevice(runtime, actor.userId, deviceId, 'opted_out');
    const changed = device.prev_ring_enabled !== device.ring_enabled;
    const audit: PushDeviceAudit = {
      id: device.id, device_id: deviceId, ...(changed ? { ring_enabled_changed: device.ring_enabled } : {}),
    };
    return reply.send({ ...(await statusOf(runtime, actor, device)), [PUSH_DEVICE_AUDIT_KEY]: audit });
  });

  // ── DELETE /push-devices/:id — revoke (sign-out) ───────────────────────
  sub.delete('/push-devices/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const actor = actorFrom(request, reply, 'query');
    if (!actor) return reply;
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const revoked = await agencyPushDeviceRepository.revoke(actor.userId, deviceId);
    // Idempotent: an unknown or already revoked device is a 204 too, and audits nothing.
    await endAwayRingForDevice(runtime, actor.userId, deviceId, 'revoked');
    if (!revoked) return reply.code(204).send();
    const audit: PushDeviceAudit = { id: revoked.id, device_id: deviceId, revoked: true };
    // 200 with only the marker; the public layer answers 204 once it has audited.
    return reply.code(200).send({ [PUSH_DEVICE_AUDIT_KEY]: audit });
  });

  // ── POST /push-devices/:id/test-ring ───────────────────────────────────
  // "Send a test ring" (the settings card): a `test_ring` push, which the phone rings locally with
  // no call behind it. The public layer rate-limits it (one per 10 s).
  sub.post('/push-devices/:id/test-ring', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const actor = actorFrom(request, reply, 'body');
    if (!actor) return reply;
    const deviceId = deviceIdOr404(request, reply);
    if (!deviceId) return reply;
    const device = await agencyPushDeviceRepository.find(actor.userId, deviceId);
    if (!device || device.revoked_at !== null || pushTokenOf(device) === null) {
      return reply.code(409).send(awayRingRefusalBody('no_push_device'));
    }
    // iOS gets a VoIP push only for a real call (IQ64): its test ring is local to the app.
    if (device.platform !== 'android' || !getPushSender().configured(device.platform)) {
      return reply.code(409).send(awayRingRefusalBody('push_unavailable'));
    }
    const sent = await runtime.awayRing.send(device, { type: 'test_ring' }, TEST_RING_PUSH_TTL_MS);
    if (!sent.ok) return reply.code(409).send(awayRingRefusalBody(pushFailureRevokes(sent.reason) ? 'no_push_device' : 'push_unavailable'));
    return reply.code(202).send({ sent: true });
  });
}
