import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import {
  createAnalysisProfileSchema,
  updateAnalysisProfileSchema,
  listAnalysisProfilesQuerySchema,
} from '../validators/call-analysis-profile.validator.js';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { getFeatureFlagService } from '../../feature-flags/index.js';
import { FLAGS } from '../../feature-flags/registry.js';
import { auditLogger } from '../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';

/*
 * PORT NOTE (magick-agency): ported from core `src/api/routes/call-analysis-profiles.routes.ts`
 * (v1.123.2). Changes, each in PORTING.md:
 *  - AUTH is an option, not an import: core's `authMiddleware` / `getTenantId` /
 *    `getAccountId` are Phase 8's merge, so the plugin takes them as
 *    `ProfileRouteAuth`, DEFAULTING TO REFUSE-ALL (401 on every route) so nothing
 *    ships unauthenticated;
 *  - the agency-campaign reference check reads `agencyCampaignRepository` in core
 *    (lane B's repository, not on this branch): it is a `ProfileDependents` option
 *    with core's two method signatures, and when absent PUT and DELETE refuse (503)
 *    rather than retire a profile unguarded;
 *  - the flag gate is `agency_call_analysis` alone: core ORed in
 *    `dialer_call_analysis` (the softphone's flag, which does not exist here).
 *  - SECURITY: `findActiveSuccessor` is scoped to the caller's tenant/account (core
 *    passes the id alone, so another tenant's superseded id returned a 409 leaking
 *    that tenant's current profile id; flagged for a later core fix);
 * Everything else - validation, copy-on-write, the 409 bodies, audit events - is
 * core's, verbatim.
 */

/** One live agency campaign that depends on a profile (core's `AgencyCampaignDependent`). */
export interface AgencyCampaignDependent {
  id: string;
  status: string;
}

/** The two reads of `agencyCampaignRepository` the reference check uses (signatures verbatim). */
export interface ProfileDependents {
  findLiveDependentsOnAnalysisProfile(
    profileId: string,
    tenantId: string,
    accountId: string,
  ): Promise<AgencyCampaignDependent[]>;
  countLiveCampaignsInheritingAccountDefault(tenantId: string, accountId: string): Promise<number>;
}

/** What the routes need from the platform's auth layer (merged in Phase 8). */
export interface ProfileRouteAuth {
  preHandler: preHandlerAsyncHookHandler;
  getTenantId(request: FastifyRequest): string;
  getAccountId(request: FastifyRequest): string;
}

/** The default: every request is refused before any handler runs. */
export const REFUSE_ALL_AUTH: ProfileRouteAuth = {
  async preHandler(_request, reply) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication is not configured for this route' });
  },
  getTenantId() {
    throw new Error('profile routes: no auth configured');
  },
  getAccountId() {
    throw new Error('profile routes: no auth configured');
  },
};

export interface CallAnalysisProfilesRoutesOptions {
  auth?: ProfileRouteAuth;
  dependents?: ProfileDependents;
}

const log = createChildLogger({ component: 'call-analysis-profiles-routes' });

/**
 * How many campaign ids the `profile_in_use_by_agency_campaign` refusal carries in
 * `details.campaigns`.
 *
 * The message beside it is bounded by the status vocabulary — it groups, so forty
 * dependents read as easily as two. `details.campaigns` was bounded by nothing,
 * and the population it enumerates is "every non-terminal campaign naming this
 * profile", with `draft` counting as live and no `DELETE` for an agency campaign
 * anywhere. An account that has reused one profile across a year of drafts puts
 * thousands of UUIDs into an error body that a browser then has to hold.
 *
 * A sample, not a page: nothing consumes this field yet, and its stated purpose is
 * to let a console holding `agency.analytics` resolve a few names to show the
 * operator which campaigns they are. Twenty is enough for that and far short of
 * the "clone the profile" remedy, which does not depend on the list at all.
 * `campaigns_total` beside it is what makes the trim visible: a truncation the
 * reader cannot see is worse than the truncation.
 */
const DEPENDENT_SAMPLE_LIMIT = 20;

/**
 * Call-analysis profiles — reusable, nameable, defaultable dimension sets for
 * post-call analysis (the dialer's answer to prompt `analytics_config`).
 * Copy-on-write versioning + soft delete + active-name uniqueness, mirroring
 * prompt templates. Mounted unconditionally; a feature flag gates behavior per
 * tenant/account (403 when off) — see `analysisEnabled`.
 *
 * A profile is also the agency dialer's analysis definition — a shared primitive
 * with two consumers and only one editor (Q3). The two routes that retire a
 * version, PUT and DELETE, therefore answer to `agencyDependencyRejected` below.
 */
export async function callAnalysisProfilesRoutes(
  app: FastifyInstance,
  opts: CallAnalysisProfilesRoutesOptions = {},
): Promise<void> {
  const auth = opts.auth ?? REFUSE_ALL_AUTH;
  const getTenantId = auth.getTenantId;
  const getAccountId = auth.getAccountId;
  const dependents = opts.dependents;
  app.addHook('preHandler', auth.preHandler);

  /**
   * Flag gate for the whole profile surface: EITHER product's analysis flag opens
   * it.
   *
   * ── Why an OR, when every other analysis gate picks one product ────────────
   *
   * Because this is the one surface where core genuinely cannot know which
   * product is asking. Everywhere else the scope is on the request — the softphone
   * route is the softphone's, an agency campaign edit is agency's, a call carries
   * a `campaign_id` — and those gates take a required `scope` and resolve it
   * through `analysisFlagFor`. A profile row has no product: no column says which,
   * both products point at the same ids, and a campaign that names none inherits
   * the account default, so the same row is frequently both products' definition
   * at once (Q3 — a shared primitive, and deliberately not promoted to a neutral
   * capability until a third consumer appears).
   *
   * Gating it on `dialer_call_analysis` alone made the sibling flags incoherent:
   * an agency-only tenant — precisely the tenant the split exists to serve, per
   * the registry's own note that "an agency tenant that runs no softphone must be
   * able to turn this on without turning that on" — got analysis RUNNING on every
   * campaign call while every route that configures it answered 403 "Dialer call
   * analysis is not enabled for this account." A feature they are paying for, with
   * no reachable way to define what it measures.
   *
   * This mirrors master, which already ORs the capability half
   * (`requireAnyCapability('calls.dialer.analytics','agency.analytics')` on the
   * list route in `proxy-call-analysis-profiles.routes.ts`). Note master ORs the
   * LIST and keeps `calls.dialer.analytics` alone on the other four: authoring
   * authority is the primary app's, which is a governance decision and master's to
   * make. The flag layer is answering a different question — "is post-call
   * analysis a feature of this account at all" — and for that, either product
   * saying yes is yes. Two layers, two questions; a tenant needs both.
   */
  const analysisEnabled = async (
    tenantId: string,
    accountId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const flags = getFeatureFlagService();
    const ctx = { tenantId, accountId };
    // Sequential, and short-circuiting on the softphone flag: it is the one that
    // is on for almost every account that reaches this surface, so the agency
    // resolution is usually not spent at all.
    const enabled = await flags.isEnabled(FLAGS.agency_call_analysis, ctx);
    if (!enabled) {
      reply.code(403).send({
        error: 'Feature Not Enabled',
        // Names neither product: with both flags off, pointing at one of them
        // would send the operator to a switch that is not the only one missing.
        message: 'Call analysis is not enabled for this account.',
      });
      return false;
    }
    return true;
  };

  /**
   * Q3's reference check: a live agency campaign vetoes removing the profile it
   * depends on (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
   *
   * Analysis profiles are a **shared primitive** — the softphone attaches one per
   * call, an agency campaign names one in its config, or names none and inherits
   * the account default — but only this surface can retire one, and master gates it
   * on `calls.dialer.analytics` ALONE. So a primary-app admin could take away a
   * running campaign's analysis definition, with nothing refusing them and nothing
   * telling anyone. The profile stays shared (no promotion to a neutral capability
   * until a third consumer appears); what changes is that *removal* now answers to
   * the other consumer.
   *
   * ── Two dependencies, two different rules ─────────────────────────────────
   *
   * 1. **A campaign naming THIS profile** — refused for both verbs. It named a
   *    specific version, so replacing that version silently changes what it
   *    measures.
   * 2. **A campaign naming NOTHING, inheriting the account default** — refused only
   *    when the operation leaves the account with no active default. That campaign
   *    asked for "whatever the default is", so a change of default is inside what
   *    it requested; a *missing* default is not, and collapses its snapshot to
   *    `{ custom_dimensions: [] }` with no error anywhere.
   *
   * The second case is the one an earlier draft of this guard missed entirely, and
   * it was the more destructive of the two — see
   * `countLiveCampaignsInheritingAccountDefault`. `analysis_profile_id` on a
   * campaign is opt-in with no column default, so inheriting is the ORDINARY case,
   * not the edge.
   *
   * ── Both mutation paths, because both retire a version ────────────────────
   *
   * There is no hard delete here: `DELETE` is `is_active = false`. And `PUT` is
   * copy-on-write — it deactivates the addressed row and inserts a successor under
   * a NEW id — so it removes exactly the version a campaign names, just as
   * thoroughly, and leaves it pointing at a dead row that the end-of-call gate's
   * unscoped `findById` will happily go on resolving. One guard, both routes,
   * mirroring `analysisProfileRejected` in `agency-campaigns.routes.ts`: it is one
   * shared helper and not two checks so that the two paths cannot drift.
   *
   * ── Why PUT is refused rather than re-pointed ─────────────────────────────
   *
   * The alternative considered was carrying live references forward to the
   * successor inside the same transaction — treating the lineage, not the row, as
   * the thing a campaign names. Rejected twice over: it makes a primary-app edit
   * silently change what a running agency campaign measures with no signal to the
   * depending side, and it writes agency rows from a primary-app route, which is
   * the cross-product coupling this boundary exists to remove. Refusing costs an
   * operator a detour — clone the profile, point the campaign at the clone — and a
   * detour is legible, whereas an edit that never arrives is not.
   *
   * The cost is real and worth stating: while any non-terminal campaign NAMES a
   * profile, that profile is read-only, and a forgotten `draft` is enough to do it.
   * If that becomes the complaint, the answer is to narrow
   * `AGENCY_CAMPAIGN_TERMINAL_STATUSES`, not to drop the guard from PUT.
   *
   * ── Advisory by construction, and staying that way ────────────────────────
   *
   * These reads happen outside the mutation and nothing locks the profile row, so a
   * campaign committed between them and the write is invisible here. That is
   * deliberate and it is where a reviewer arrives first, so the argument lives one
   * hop away rather than being re-derived: see the race note on
   * `findLiveDependentsOnAnalysisProfile` and §7b's "What the guard does not
   * close". The short form: serialising it would put a lock on a primary-app table
   * inside every agency campaign write, the two dependency classes lose the race
   * differently (a naming campaign keeps resolving the retired row through the
   * unscoped `findById`; an inheriting campaign created in the window gets an empty
   * snapshot), and for the class that actually degrades a lock buys no invariant,
   * because the same empty snapshot is reachable with no race at all.
   *
   * ── Only the ACTIVE version is guarded ────────────────────────────────────
   *
   * The lookup comes first so a superseded or missing id falls straight through to
   * the route's ordinary answer. Guarding it instead would preempt the
   * `stale_profile_version` 409 — whose `details.current_profile_id` is the one
   * signal a stale tab can recover from — with "this is in use", which is both
   * unhelpful and false: saving a row that is already retired changes nothing.
   */
  const agencyDependencyRejected = async (
    profileId: string,
    tenantId: string,
    accountId: string,
    action: 'edit' | 'retire',
    /**
     * Whether this operation leaves the account with NO active default profile.
     * `DELETE` of the default always does. A `PUT` does only when it explicitly
     * sets `is_default: false` — `update` computes `input.is_default ?? existing`,
     * so an omitted flag is carried onto the successor and the inheritance still
     * resolves. Required rather than defaulted: getting it wrong in the false
     * direction reintroduces exactly the hole this parameter closes.
     */
    clearsAccountDefault: boolean,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (!dependents) {
      // Fail closed: retiring a profile without the campaign reference check is the
      // silent breakage this guard exists to prevent.
      reply.code(503).send({
        error: 'Service Unavailable',
        message: 'The agency campaign reference check is not configured; profile edits are refused.',
      });
      return true;
    }
    const active = await callAnalysisProfileRepository.findByIdScoped(profileId, tenantId, accountId);
    if (!active) return false;

    const named = await dependents.findLiveDependentsOnAnalysisProfile(
      profileId, tenantId, accountId,
    );
    const inheriting = active.is_default && clearsAccountDefault
      ? await dependents.countLiveCampaignsInheritingAccountDefault(tenantId, accountId)
      : 0;
    if (named.length === 0 && inheriting === 0) return false;

    // The code is the load-bearing part, not the prose: master's error mask
    // rewrites any core 4xx it cannot recognise into "contact support and quote
    // this request id", and this refusal is one an operator fixes in a couple of
    // clicks — see the header of `src/analysis/profile-preflight.ts` for the whole
    // argument. It is allow-listed in master's `FORWARDABLE_ERROR_CODES` by this
    // exact string, so a rename here is a silently unreadable error at the browser.
    //
    // No campaign NAMES in the message or in `details` — see
    // `AgencyCampaignDependent`. The reader may hold no agency entitlement, so the
    // message carries a count and a status breakdown rather than a roll-call.
    //
    // Be precise about what that does and does not seal, because three comments
    // (here, `AgencyCampaignDependent`, and master's allow-list entry) previously
    // stated it as absolute and it is not: **campaign UUIDs do cross.**
    // `details.campaigns` is opaque ids and a closed status enum, and it is
    // deliberate — it is the only thing a console holding `agency.analytics` can
    // resolve into "which campaigns", which is the remedy this refusal exists to
    // enable. What is withheld is the agency product's VOCABULARY: an operator-
    // authored campaign name tells a reader with no agency entitlement what the
    // agency side is selling and to whom, and an opaque id tells them nothing they
    // did not already have — they are holding this profile's id and asking about
    // its dependents, so the existence and the count are already disclosed by the
    // refusal itself. Ids are the smallest disclosure that still carries a remedy.
    //
    // Bounded, though. See `DEPENDENT_SAMPLE_LIMIT`.
    const parts: string[] = [];
    if (named.length > 0) {
      const byStatus = [...named.reduce((m, c) => m.set(c.status, (m.get(c.status) ?? 0) + 1), new Map<string, number>())]
        .map(([status, n]) => `${n} ${status}`)
        .join(', ');
      parts.push(`${named.length} agency campaign${named.length === 1 ? '' : 's'} (${byStatus}) `
        + `${named.length === 1 ? 'uses' : 'use'} this profile directly`);
    }
    if (inheriting > 0) {
      // "more" only when there is something for them to be more THAN. With no named
      // dependents the sentence opens on this clause, and "3 more rely on it" reads
      // as though a first group had been elided.
      const more = parts.length > 0 ? 'more ' : '';
      parts.push(`${inheriting} ${more}campaign${inheriting === 1 ? '' : 's'} `
        + `${inheriting === 1 ? 'relies' : 'rely'} on it as the account default`);
    }

    const remedy = action === 'retire'
      ? 'Point them at another profile, or clone this one, before deleting it.'
      : 'Saving replaces this profile with a new version and would leave them pointing at '
        + 'the retired one. Clone this profile and edit the copy, or point them elsewhere first.';

    reply.code(409).send({
      error: 'Conflict',
      code: 'profile_in_use_by_agency_campaign',
      message: `${parts.join(', and ')}. ${remedy}`,
      details: {
        reason: 'profile_in_use_by_agency_campaign',
        // A bounded SAMPLE, with the true count beside it. `named.length` is what
        // the message counts, so the two can never disagree, and
        // `campaigns_truncated` states the trim outright rather than leaving a
        // reader to notice that a list of 20 sits under a total of 900.
        campaigns: named.slice(0, DEPENDENT_SAMPLE_LIMIT),
        campaigns_total: named.length,
        campaigns_truncated: named.length > DEPENDENT_SAMPLE_LIMIT,
        inheriting_account_default: inheriting,
      },
    });
    return true;
  };

  // POST / — create a profile. 409 on duplicate active name; is_default clears the
  // previous default in the same transaction (handled in the repository).
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await analysisEnabled(tenantId, accountId, reply))) return;

    const parsed = createAnalysisProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }

    // Friendly 409 ahead of the partial unique index.
    const dupe = await callAnalysisProfileRepository.findActiveByName(tenantId, accountId, parsed.data.name);
    if (dupe) {
      return reply.code(409).send({
        error: 'Profile Already Exists',
        message: `An analysis profile named "${parsed.data.name}" already exists.`,
        profile_id: dupe.id,
      });
    }

    let created;
    try {
      created = await callAnalysisProfileRepository.create({
        tenant_id: tenantId,
        account_id: accountId,
        name: parsed.data.name,
        description: parsed.data.description,
        context: parsed.data.context,
        custom_dimensions: parsed.data.custom_dimensions,
        language_hint: parsed.data.language_hint,
        is_default: parsed.data.is_default,
      });
    } catch (err) {
      // Lose the pre-check race → the partial unique index trips (23505). Surface
      // the same friendly 409 rather than a raw 500.
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'Profile Already Exists', message: `An analysis profile named "${parsed.data.name}" already exists.` });
      }
      throw err;
    }

    auditLogger.log({
      tenantId,
      accountId,
      eventType: 'call_analysis_profile.created',
      eventCategory: 'api',
      severity: 'info',
      eventData: { profileId: created.id, name: created.name, isDefault: created.is_default },
    });

    return reply.code(201).send(created);
  });

  // GET / — paginated list of the account's active profiles.
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await analysisEnabled(tenantId, accountId, reply))) return;

    const parsed = listAnalysisProfilesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }
    const { limit, offset } = parsed.data;
    const { rows, total } = await callAnalysisProfileRepository.listByTenant(tenantId, accountId, limit, offset);
    return reply.send({ profiles: rows, total, limit, offset });
  });

  // GET /:id — profile detail (scoped 404).
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await analysisEnabled(tenantId, accountId, reply))) return;

    const profile = await callAnalysisProfileRepository.findByIdScoped(request.params.id, tenantId, accountId);
    if (!profile) return reply.code(404).send({ error: 'Not Found', message: 'Analysis profile not found' });
    return reply.send(profile);
  });

  // PUT /:id — copy-on-write update (new version). 409 + successor id if the
  // referenced version was already superseded (stale write), mirroring prompts.
  app.put('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await analysisEnabled(tenantId, accountId, reply))) return;

    const parsed = updateAnalysisProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.issues });
    }

    // After the body parse (pure, no round trip) and before the write: a copy-on-
    // write update retires the version a campaign names. See the helper.
    // `clearsAccountDefault` is `input.is_default === false` and nothing looser:
    // an OMITTED flag is carried forward onto the successor by `update`, so the
    // account keeps an active default and inheritors are unaffected.
    if (await agencyDependencyRejected(
      request.params.id, tenantId, accountId, 'edit', parsed.data.is_default === false, reply,
    )) return;

    let updated;
    try {
      updated = await callAnalysisProfileRepository.update(request.params.id, tenantId, accountId, parsed.data);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'Profile Already Exists', message: 'An analysis profile with this name already exists.' });
      }
      throw err;
    }
    if (!updated) {
      // The referenced row is missing, cross-tenant, or already superseded. If a
      // successor exists it's a stale-version 409; otherwise a genuine 404.
      const successor = await callAnalysisProfileRepository.findActiveSuccessor(request.params.id, tenantId, accountId);
      if (successor) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This profile version is no longer active. Reload the current version and try again.',
          details: { reason: 'stale_profile_version', current_profile_id: successor.id },
        });
      }
      return reply.code(404).send({ error: 'Not Found', message: 'Analysis profile not found' });
    }

    auditLogger.log({
      tenantId,
      accountId,
      eventType: 'call_analysis_profile.updated',
      eventCategory: 'api',
      severity: 'info',
      eventData: { profileId: updated.id, name: updated.name, version: updated.version },
    });

    return reply.send(updated);
  });

  // DELETE /:id — soft delete (scoped). Dialer analysis jobs are self-contained
  // (they snapshot the dimensions), so nothing on the softphone side needs a
  // reference guard — but a live agency campaign re-reads this id on every dial,
  // and does need one. 409 with `profile_in_use_by_agency_campaign`.
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await analysisEnabled(tenantId, accountId, reply))) return;

    // A soft delete always removes the account's default if this row held it.
    if (await agencyDependencyRejected(
      request.params.id, tenantId, accountId, 'retire', true, reply,
    )) return;

    const deleted = await callAnalysisProfileRepository.softDelete(request.params.id, tenantId, accountId);
    if (!deleted) return reply.code(404).send({ error: 'Not Found', message: 'Analysis profile not found' });

    auditLogger.log({
      tenantId,
      accountId,
      eventType: 'call_analysis_profile.deleted',
      eventCategory: 'api',
      severity: 'info',
      eventData: { profileId: request.params.id },
    });

    log.info({ profileId: request.params.id }, 'Analysis profile deleted');
    return reply.code(204).send();
  });
}
