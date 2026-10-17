import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { registerCampaignCrudRoutes } from './proxy-agency-campaigns/crud.js';
import { registerCampaignStatsRoutes } from './proxy-agency-campaigns/stats.js';
import { registerCampaignActivityRoutes } from './proxy-agency-campaigns/activity.js';
import { registerCampaignSpineRoutes } from './proxy-agency-campaigns/spine.js';
import { registerCampaignLifecycleRoutes } from './proxy-agency-campaigns/lifecycle.js';
import { registerCampaignRetryRoutes } from './proxy-agency-campaigns/retry.js';
import { registerCampaignIngestRoutes } from './proxy-agency-campaigns/ingest.js';

/**
 * Campaign CRUD and roster ingest.
 *
 * ── The ownership split, and why this layer keeps no campaign table ────────
 * The dialer runtime owns `agency_campaigns` — name, caller IDs, calling
 * windows, disposition catalog, `context_display`, status. The public API layer
 * does NOT keep a second copy: campaign CRUD here is a thin pass-through to the
 * internal handler instance, because two writable copies of one business object
 * is how they drift, and the pacing engine has to read the authoritative version
 * on every tick anyway.
 *
 * What this layer genuinely owns is the FILE and the act of turning it into a
 * roster — the S3 object, the operator's column mapping, and the streamed
 * hand-off. The file is the source of truth here; the roster is the dialer
 * runtime's. That is `agency_ingest_jobs` and the routes in `./proxy-agency-campaigns/ingest.ts`.
 *
 * ── There is no concurrency setter here, and that is deliberate ────────────
 * `account_settings.max_concurrent_calls` is reachable only through the
 * super-admin tree. No `/proxy/account-settings` route exists and none is being
 * added: concurrency is a commercial lever, and an account that can raise its
 * own limit can raise its own carrier spend. The supervisor dashboard renders
 * the limit read-only. If a "set concurrency" field ever appears in an AGENCY
 * campaign payload, it is a bug — the dialer runtime owns the campaign schema
 * and has no such column.
 */
/*
 * ─── The two `behavioral` capabilities, actually enforced ────────────────────
 *
 * `assertBehavioralCapabilitiesForConfig` and `resolveInheritedBehavioralConfig`
 * live in `apps/server/src/agency/campaign-behavioral-settings.ts`, which carries
 * the full rationale. Two rules from there apply at every call site in this family:
 *  1. `agency.recording` / `agency.analytics` are the per-account settings row
 *     (`allow_recording` / `analyze_calls`), judged for the account that OWNS the
 *     campaign — the `target` argument — never the request's header alone;
 *  2. there is no raw-`request.body` convenience: each route passes the exact
 *     object it forwards to the internal handler.
 * The 403 body is `{ error: 'capability_disabled', capability }`; a missing row or
 * a NULL column is "off", and a failed read fails closed.
 */
export async function proxyAgencyCampaignsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // Every `callCore({...})` this family makes (`../core-dispatch.ts`, decision B16) runs the internal
  // handler in-process with the given method, path, query, body and tenant/account headers.
  /*
   * ─── A PARAM MUST NOT ADD PATH SEGMENTS ──────────────────────────────────
   *
   * Every route here interpolates `:id` / `:contactId` straight into an internal
   * handler path, and find-my-way hands the handler a percent-DECODED param — so
   * `%2F` arrives as a real `/`.
   *
   * The classic `..` traversal is NOT what this closes. `callCore` already
   * refuses any path that does not survive a WHATWG parse unchanged
   * (`isUnsafeCorePath`, `src/proxy/safe-core-path.ts`), which covers `..`,
   * `%2e%2e`, `.%2e`, `#` and `\` — strictly more than a character check could.
   * What it deliberately does not refuse is a BARE EXTRA SLASH, because a path
   * with no dot segments is an ordinary handler path and has to be allowed.
   *
   * On this plugin that is a live privilege escalation, because its routes do not
   * share one floor. `GET /campaigns/:id` is `agency.campaigns.read`
   * (**viewer**, 10) and interpolates `:id` as the LAST segment of its handler
   * path, while the attempt read is `agency.supervise` (**account_admin**, 30) and
   * its media additionally needs the `agency.recording` capability. So:
   *
   *   GET /proxy/agency/campaigns/campaign-1%2Fattempts%2Fattempt-1
   *     → /agency-campaigns/campaign-1/attempts/attempt-1     (a viewer, reading
   *       a conversation the product floors at account_admin)
   *
   *   GET /proxy/agency/campaigns/campaign-1%2Fattempts%2Fa%2Frecording
   *     → the recording BYTES, with no `agency.recording` in the request at all
   *
   * That second one is the hole this whole surface was built to close — "the
   * capability gated *enabling* recording, not *hearing* it" — reopened by a
   * slash. Same-tenant (the internal handler scopes by `x-mgkvc-tenant`), so it
   * is a capability bypass rather than a data-isolation break, but capabilities
   * and role floors are what the customer is entitled and billed by.
   *
   * ── A plugin hook, and the character class rather than a uuid check ────────
   *
   * A hook because the defect is a hand-written route missing a guard, and a
   * per-handler check can be missed again; the next route registered here
   * inherits this one.
   *
   * The character class because these ids are uuids only by convention — nothing
   * in this plugin says so and its own suites use short opaque ids (`c1`,
   * `campaign-1`). Reject rather than encode, for the reason in `path-params.ts`:
   * encoding changes the bytes on the wire for every id, while rejecting changes
   * behaviour only for requests that were already exploits.
   */
  app.addHook('preHandler', rejectPathEscapingParams());

  // The routes, by family (`./proxy-agency-campaigns/`), on THIS instance so every
  // hook above applies to each of them.
  await registerCampaignCrudRoutes(app);
  await registerCampaignStatsRoutes(app);
  await registerCampaignActivityRoutes(app);
  await registerCampaignSpineRoutes(app);
  await registerCampaignLifecycleRoutes(app);
  await registerCampaignRetryRoutes(app);
  await registerCampaignIngestRoutes(app);
}
