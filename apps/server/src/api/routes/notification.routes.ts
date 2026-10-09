import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { notificationPreferenceRepository } from '../../db/repositories/notification-preference.repository.js';
import {
  NOTIFICATION_EVENTS,
  type NotificationEventDefinition,
} from '../../notifications/engine/catalog.js';
import {
  isEventAddressableToRole,
  resolveEffectivePreferences,
} from '../../notifications/engine/audience.js';
import {
  updateNotificationPreferencesSchema,
} from '../validators/notification.validator.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'notification-routes' });

/**
 * `/notifications` — a person's own subscriptions.
 *
 * ── Authenticated, tenant-scoped, and deliberately WITHOUT `requirePermission`
 *
 * Every route here is about the CALLER and nobody else. The subject is
 * `request.user.id`, taken server-side; there is no `user_id` parameter on any
 * of them, and adding one would turn "my settings" into an administrative
 * surface that could read or rewrite a colleague's subscriptions while passing
 * every role check — the same mistake the agency `my-*` routes exist to avoid,
 * and the reason those use a query whitelist rather than a convention.
 *
 * So the PREFERENCE routes have no permission floor: a `viewer` manages their own
 * preferences exactly as a `tenant_owner` does, and gating on any existing
 * permission would lock somebody out of their own unsubscribe. What bounds the
 * damage is that the caller can only ever address themselves. "Only ever
 * themselves" is a bound on the SUBJECT, not on the PAYLOAD: any route added here
 * that returns workspace data rather than a personal setting needs a permission
 * floor of its own. The module-level absence of `requirePermission` is about
 * self-service, not a property of the prefix.
 *
 * There are no platform API keys in v1, so `sessionMiddleware` has no key branch
 * and every caller here is a person.
 *
 * ── What a low-privilege role sees ────────────────────────────────────────
 *
 * `GET /preferences` serves only the events the caller could actually receive;
 * the filter lives in the handler. The catalog's one event,
 * `agency.campaign.completed`, floors at `agency.supervise`, so an `agent`
 * (level 5) is served an empty `events` list rather than a toggle that cannot
 * fire.
 */
/**
 * The events this caller could actually RECEIVE, in catalog order, plus the
 * membership rows they were derived from.
 *
 * One function rather than the same `filter` inline in each handler, so `GET`
 * and `PUT` cannot drift: a save that handed back the whole catalog would give
 * any page that hydrates from the save response the hidden events straight back.
 *
 * `memberships` is returned alongside the visible events; no current caller
 * reads it.
 */
async function addressableEventsFor(
  userId: string,
  tenantId: string,
): Promise<{ memberships: Awaited<ReturnType<typeof membershipRepository.findByUserAndTenant>>; visible: NotificationEventDefinition[] }> {
  const memberships = await membershipRepository.findByUserAndTenant(userId, tenantId);
  return {
    memberships,
    visible: NOTIFICATION_EVENTS.filter((event) =>
      memberships.some((m) => isEventAddressableToRole(event, m.role)),
    ),
  };
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /**
   * GET /notifications/preferences
   *
   * The catalog AND the caller's effective values, in one response.
   *
   * Served together rather than as two routes, because a client that fetched
   * only the overrides would have to carry its own copy of the catalog — the
   * labels, the descriptions, which events are digests — and that copy is
   * exactly the hand-maintained mirror the audit log's `available_actions`
   * exists to abolish, and nothing could check the copy.
   *
   * `is_default: true` marks a value that comes from the catalog rather than
   * from a stored row. The page needs it to render honestly: a user who has
   * never saved anything is genuinely subscribed, and showing that as "unset"
   * would invite them to "turn on" something already on.
   */
  app.get('/preferences', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    const tenantId = request.tenantId;
    if (!userId || !tenantId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Missing user or tenant context' });
    }

    // Only the events this caller could actually RECEIVE.
    //
    // Without this the whole catalog was served to everybody, so a `viewer` or
    // an `operator` — both below `usage.digest`'s `account_admin` floor — opened
    // the page to a live "Usage digest · On · Default" toggle with a frequency
    // picker, saved it, and never received one. `campaign-gate.ts` states the
    // rule this restores: a toggle that changes nothing is worse than no toggle,
    // because it is a promise the product does not keep.
    //
    // Note this is a DISPLAY filter, not an authorization one. There is nothing
    // to protect — the catalog is public product copy, and a stored preference
    // for an unreachable event is inert rather than dangerous (`PUT` keeps
    // accepting any catalog key, so a preference saved before a demotion
    // survives it and comes back when the role does). What it protects is the
    // page's honesty.
    const { visible } = await addressableEventsFor(userId, tenantId);

    const stored = await notificationPreferenceRepository.findForUser(userId, tenantId);
    const effective = resolveEffectivePreferences(stored, visible);
    const byKey = new Map(effective.map((pref) => [pref.eventKey, pref]));

    return reply.send({
      events: visible.map((event) => {
        const pref = byKey.get(event.key);
        return {
          key: event.key,
          label: event.label,
          description: event.description,
          category: event.category,
          cadence: event.cadence,
          channel: 'email',
          enabled: pref?.enabled ?? event.defaultEnabled,
          frequency: pref?.frequency ?? null,
          default_enabled: event.defaultEnabled,
          default_frequency: event.defaultFrequency ?? null,
          is_default: pref?.isDefault ?? true,
        };
      }),
    });
  });

  /**
   * PUT /notifications/preferences
   *
   * Upsert a sparse list. Absent events keep whatever they had — the body is a
   * patch, not a replacement, so a client built against an older catalog cannot
   * silently reset an event it has never heard of to its default.
   *
   * One statement for the whole form (`upsertMany`), so a save cannot half-apply
   * and leave the page showing something the database does not hold.
   */
  app.put('/preferences', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    const tenantId = request.tenantId;
    if (!userId || !tenantId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Missing user or tenant context' });
    }

    const parsed = updateNotificationPreferencesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      // `details` is what makes `errorMaskHook` pass this through intact — a bare
      // message would reach the customer as the generic support copy.
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }

    const rows = parsed.data.preferences.map((entry) => ({
      user_id: userId,
      tenant_id: tenantId,
      event_key: entry.event_key,
      channel: entry.channel,
      enabled: entry.enabled,
      frequency: entry.frequency ?? null,
    }));

    await notificationPreferenceRepository.upsertMany(rows);

    // Resolved against the same list `GET` serves, NOT the whole catalog.
    //
    // This line used to be `NOTIFICATION_EVENTS`, which quietly undid the GET
    // filter: the save response carried `usage.digest` (default on, weekly) to a
    // `viewer`, `operator` or `agent` who cannot receive it, so a page following
    // the ordinary "save, then replace local state from the response" pattern
    // grew the toggle-that-does-nothing back on the first click. The GET filter
    // only held until somebody pressed Save.
    //
    // Note what is deliberately NOT filtered: the ACCEPTED keys above. Validation
    // still takes any live catalog key, so a preference saved before a demotion
    // is neither rejected with a 400 nor deleted — it stays stored and inert, and
    // comes back when the role does. The filter is about what this response
    // claims the caller is subscribed to, which is a statement about the page's
    // honesty, not an authorization boundary.
    const { visible } = await addressableEventsFor(userId, tenantId);
    const stored = await notificationPreferenceRepository.findForUser(userId, tenantId);
    const effective = resolveEffectivePreferences(stored, visible);

    log.info({ userId, tenantId, count: rows.length }, 'Notification preferences updated');

    return reply.send({
      preferences: effective.map((pref) => ({
        event_key: pref.eventKey,
        channel: pref.channel,
        enabled: pref.enabled,
        frequency: pref.frequency,
        is_default: pref.isDefault,
      })),
    });
  });

  // There is no `POST /notifications/digests/preview`: there is no usage digest
  // in v1 (no credits), so that path answers 404.
}
