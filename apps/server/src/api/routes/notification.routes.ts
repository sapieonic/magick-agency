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
// PORT NOTE (magick-agency): master also imports `config`, `denyPlatformApiKey`,
// `accountRepository`, `tenantRepository`, `findNotificationEvent`,
// `formatPeriodLabel`, `resolvePeriodWindow`, `DigestFrequency`,
// `buildUsageDigest`, `renderUsageDigestEmail` and `previewDigestSchema`. Every
// one served the deleted `POST /digests/preview` or the deleted API-key guard.
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'notification-routes' });

/**
 * PORT NOTE (magick-agency): what changed from master's module.
 *  - `POST /notifications/digests/preview` is deleted. It rendered the credits
 *    usage digest (billed millicredits, campaign counts), and Magick Agency v1
 *    has no credits and no digest event (plan §3.3, §3.5).
 *  - The `denyPlatformApiKey` preHandler is deleted (decision #5: no platform API
 *    keys, so `sessionMiddleware` has no key branch and there is no machine
 *    caller to refuse).
 *  - `GET` / `PUT /preferences` are master's, unchanged, and still have NO
 *    permission floor: an `agent` must reach its own preferences (plan §9).
 *    With agency's one-event catalog, an `agent` (below the `agency.supervise`
 *    floor) is served an empty `events` list — see the last paragraph below,
 *    whose `campaign.*` events do not exist here.
 * Master's header follows, verbatim; its paragraphs on the preview and on API
 * keys describe what was deleted.
 *
 * `/notifications` — a person's own subscriptions, and a preview of what they
 * would receive.
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
 * damage is that the caller can only ever address themselves.
 *
 * `POST /digests/preview` is the EXCEPTION, and the distinction is what the
 * route returns rather than whose settings it touches. "Only ever themselves" is
 * a bound on the SUBJECT, and it says nothing about the PAYLOAD: the preview
 * builds the workspace's billed usage and campaign figures, which are not the
 * caller's own data in any sense that a membership check speaks to. So it
 * carries the `usage.digest` catalog floor — see the check in the handler. Any
 * route added here that returns workspace data rather than a personal setting
 * needs the same treatment; the module-level absence of `requirePermission` is
 * about self-service, not a property of the prefix.
 *
 * ── Platform API keys are refused ─────────────────────────────────────────
 *
 * `denyPlatformApiKey`, for the reason `GET /auth/me` gives: there is no "me"
 * for a machine credential. A key minted by a person authenticates carrying that
 * person's `UserRecord` (`sessionMiddleware`'s key branch loads
 * `platform_api_keys.created_by`), so without this guard a leaked key would
 * read — and silently rewrite — its creator's personal notification settings,
 * with the audit trail naming somebody who did not make the request.
 *
 * ── What a low-privilege role sees ────────────────────────────────────────
 *
 * `GET /preferences` serves only the events the caller could actually receive,
 * and this paragraph used to claim that happened by itself. It did not: the
 * handler mapped the whole catalog unconditionally, so the claim below was a
 * description of an intention rather than of the code — which is how it passed
 * review. The filter is now real, and lives in the handler.
 *
 * So an `agent` (level 5) sees only the two `campaign.*` events, whose audience
 * is explicitly-typed addresses that may be anybody's, including theirs. They do
 * NOT see `usage.digest` or the agency notice, both of which floor above them.
 * Refusing the whole route to such a caller would be wrong — they have real
 * subscriptions to manage — and so would offering them a toggle that cannot fire.
 */
/**
 * The events this caller could actually RECEIVE, in catalog order, plus the
 * membership rows they were derived from.
 *
 * One function rather than the same `filter` inline in each handler, because the
 * two places that had it inline did not stay equal: `GET` was corrected to
 * filter and `PUT` was not, so a save handed back the whole catalog and any page
 * that hydrates from the save response got the hidden events straight back. A
 * shared helper is the only version of this that cannot drift again.
 *
 * `memberships` is returned alongside because two callers need the raw rows for
 * something else — the digest floor check and the preview's widest-scope
 * account resolution — and re-reading them would be a second query answering a
 * question already answered.
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
  // PORT NOTE (magick-agency): master's third hook,
  // `denyPlatformApiKey("manage a person's own notification settings")`, is
  // deleted — decision #5, no platform API keys.

  /**
   * GET /notifications/preferences
   *
   * The catalog AND the caller's effective values, in one response.
   *
   * Served together rather than as two routes, because a client that fetched
   * only the overrides would have to carry its own copy of the catalog — the
   * labels, the descriptions, which events are digests — and that copy is
   * exactly the hand-maintained mirror the audit log's `available_actions`
   * exists to abolish. Master is not a dependency of the SPA and nothing could
   * check the copy.
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

  // PORT NOTE (magick-agency): master's `POST /notifications/digests/preview`
  // (master `notification.routes.ts:253-420`) is deleted — it built and
  // rendered the credits usage digest, which Magick Agency v1 does not have
  // (plan §3.3, §3.5). The route answers 404 here.
}
