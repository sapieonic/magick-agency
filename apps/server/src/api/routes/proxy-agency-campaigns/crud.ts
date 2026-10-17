/*
 * Campaign CRUD — a thin pass-through; the dialer runtime owns the schema. Part of
 * `proxy-agency-campaigns.routes.ts`, whose header states the ownership split and the
 * behavioral-capability rules these routes apply.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { forwardCore } from '../../core-dispatch.js';
import { ACCOUNT_HEADER } from '../../middleware/headers.js';
import { assertBehavioralCapabilitiesForConfig } from '../../../agency/campaign-behavioral-settings.js';
import {
  validateAgencyCampaignConfig,
  withCampaignConfigDefaults,
  issuesToDetails,
} from '../../../agency/agency-campaign-config.js';

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignCrudRoutes(app: FastifyInstance): Promise<void> {
  // ─── Campaign CRUD — thin pass-through, the dialer runtime owns the schema ──

  app.post('/campaigns', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    // Config validation only. The body is still forwarded as-is and the dialer
    // runtime still owns the schema — this layer keeps no campaign copy (see the
    // ownership-split comment at the top of `proxy-agency-campaigns.routes.ts` on why two writable copies
    // drift). What this catches is the set of shapes the dialer runtime stores
    // happily and then behaves wrongly on; see
    // `agency-campaign-config.ts` for why it is a good error message rather than
    // enforcement.
    const configIssues = validateAgencyCampaignConfig(request.body);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    // Defaults are applied on CREATE only. `disposition_catalog` has a `'[]'`
    // column default that nothing seeds, so disposition would be inert on every
    // campaign created without one. A default here fixes that without deleting
    // the empty-catalog configuration, because an explicit `[]` is an opinion and
    // is left alone — see `withCampaignConfigDefaults`.
    const body = withCampaignConfigDefaults(request.body);

    // The behavioral capabilities. After the shape check (a malformed body earns
    // its 400 either way) and before anything is forwarded — the whole point is
    // that the internal handler never sees a body that enables a capability this
    // account does not have.
    //
    // Asserted on `body`, the exact object forwarded below, not on `request.body`.
    // `withCampaignConfigDefaults` is pure and adds only `disposition_catalog`, so
    // asserting after it changes no outcome and makes the asserted object the
    // forwarded one. The target is the request's tenant and account: the internal
    // handler stamps the new row with exactly those (`x-mgkvc-tenant` /
    // `x-mgkvc-account`), so the account judged is the account that will own the
    // campaign.
    // With no account context the settings read has no row to judge
    // (`campaign-behavioral-settings.ts` would answer 403 `capability_disabled`),
    // so a missing account is answered first, as the 400 the internal handler's
    // `authMiddleware` gives for a missing `x-mgkvc-account`.
    if (!request.accountId) return reply.code(400).send(missingAccountBody());
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, body, {
      tenantId: request.tenantId,
      accountId: request.accountId,
    }))) return;

    return forwardCore(request, reply, {
      method: 'POST',
      path: '/agency-campaigns',
      body,
    });
  });

  app.get('/campaigns', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: '/agency-campaigns',
      query: request.query as Record<string, string>,
    });
  });

  app.get<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}`,
    });
  });

  app.patch<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    // Same validation on the patch surface, and it has to be: the builder edits a
    // running campaign's window and catalog here, so validating only on create
    // would leave every rule reachable one PATCH later.
    //
    // Cross-field rules see only what THIS body carries — a patch sending
    // `calling_window_start` alone cannot be checked against a stored `end` this
    // layer does not hold. That is the cost of not keeping a copy, and it is the
    // right trade: the alternative is a second writable campaign here.
    //
    // ── Editing a RUNNING campaign — the documented rule ────────────────────────
    // **Allowed, and this layer adds no campaign-status gate.** Pausing to change a
    // calling window is the opposite of what a compliance edit needs: the window is
    // most often wrong *while* the campaign is dialing outside it, and forcing a
    // pause there means either dialing on for the length of the round trip or
    // stopping a compliant campaign to fix a non-compliant one.
    //
    // This layer could not enforce such a gate honestly in any case — it holds no
    // campaign copy, so it would have to GET the campaign first and act on a status
    // that can change between the two calls. The internal handler is where a status
    // rule belongs, and it deliberately has none on PATCH (only `status` itself is
    // unpatchable, so lifecycle stays with /start, /pause, /resume, /stop and a
    // config edit can never race the pacing leader's own writes).
    //
    // **When the edit takes effect, stated precisely — "applies to future attempts
    // only" is close but not exact.** The pacing loop re-reads the campaign every
    // tick (`findActive()` / `findById()`, no cache), so:
    //  - a contact NOT yet dialed is planned against the new config from the next
    //    tick — the ordinary case;
    //  - an attempt ALREADY dispatched carries the campaign snapshot taken when it
    //    was dialed (`cmd.campaign`), so its own retry decision uses the OLD policy;
    //  - EXCEPT down the reaper's path, which joins `c.retry_policy` live
    //    (`findLapsedWrapups` in `agency.repository.ts`) and therefore resolves
    //    against the NEW policy for an attempt dialed before the edit.
    // So "future attempts only" holds for the dial path and not for the reaper.
    // Nothing in flight is retro-actively re-planned either way, which is the
    // property that makes editing a live campaign safe to offer.
    const configIssues = validateAgencyCampaignConfig(request.body);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    // The behavioral capabilities, and they have to be checked here as well as on
    // create for the same reason the config validation is: a rule enforced only on
    // POST is a rule one PATCH away from being bypassed. A campaign created with
    // recording off can otherwise be patched to `record_calls: true` by an account
    // that never had the capability.
    //
    // The forwarded body is bound ONCE and that same object is both asserted and
    // forwarded. The target is the request's tenant and account, and it cannot
    // differ from the campaign's owner: the internal PATCH handler runs
    // `requireOwned`, which answers 404 unless the campaign's `tenant_id` AND
    // `account_id` equal the `x-mgkvc-tenant` / `x-mgkvc-account` headers
    // `callCore` sets from these same two values. So a body asserted against
    // account Y's settings can only ever write a campaign that account Y owns;
    // reading the row first to learn its account would be a second read that can
    // only agree.
    //
    // `request.body` is safe to use here because it is ONE reference: the object
    // `validateAgencyCampaignConfig` checked above is the object asserted here and
    // the object forwarded below (the internal handler parses it again). A body
    // that enables a capability this account lacks is refused and nothing is
    // forwarded (`proxy-agency-campaign-behavioral-capabilities.routes.test.ts`,
    // the PATCH twin cases).
    const patchBody: unknown = request.body;
    // No account context: answered as the internal handler's `authMiddleware` 400 for a
    // missing `x-mgkvc-account`, before the settings read (which has no row to judge).
    if (!request.accountId) return reply.code(400).send(missingAccountBody());
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, patchBody, {
      tenantId: request.tenantId,
      accountId: request.accountId,
    }))) return;

    return forwardCore(request, reply, {
      // PATCH, and the body must travel with it: a PATCH sent with NO body is a
      // write that does nothing and still reads as a success.
      method: 'PATCH',
      path: `/agency-campaigns/${request.params.id}`,
      body: patchBody,
    });
  });
}

/** The internal handler's `authMiddleware` 400 for a request with no account. */
function missingAccountBody(): { error: string; message: string } {
  return { error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` };
}
