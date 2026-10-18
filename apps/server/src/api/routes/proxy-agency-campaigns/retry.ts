/*
 * Retry campaigns: the preview, the create and the lineage strip. Part of
 * `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore, forwardCore } from '../../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import {
  assertBehavioralCapabilitiesForConfig,
  resolveInheritedBehavioralConfig,
} from '../../../agency/campaign-behavioral-settings.js';
import { validateAgencyCampaignConfig, issuesToDetails } from '../../../agency/agency-campaign-config.js';
import type { ConfigIssue } from '../../../agency/agency-campaign-config.js';
import { fetchOwnedCoreCampaign, stringField } from '../helpers/core-campaign.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { AUDIT_FILTER_VALUE_MAX_CHARS } from './spine.js';
import { resolveActorDisplayName } from './lifecycle.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

/** Selector dimensions kept on the audit row. The dialer runtime's vocabulary has seven. */
const AUDIT_SELECTOR_MAX_KEYS = 20;

/** Values kept per array dimension, e.g. `last_outcome: [...]`. */
const AUDIT_SELECTOR_MAX_ARRAY_ITEMS = 50;

/**
 * Bound a retry selector before it lands on the compliance trail.
 *
 * The selector belongs on the row — it is the operator's INTENT, the record of
 * which cohort somebody chose to re-dial — but it is caller-controlled and open
 * (`z.record(z.unknown())`), so it can carry a dumped phone roster, a 10k
 * disposition string, or a few thousand keys.
 *
 * This plugin already paid for exactly that once: `boundedFilters` (`spine.ts`) and
 * `AUDIT_FILTER_VALUE_MAX_CHARS` exist because a 200KB filter value landed
 * unclipped, repeatably, on the one trail a compliance reader depends on. The
 * retry row is worse in one respect: it is written on every successful create,
 * it must survive the child being deleted, and `platform_audit_log` partitions
 * drop only by age — nothing purges a wide row early.
 *
 * Same treatment, same constants where they apply. Keys are KEPT (an unknown
 * dimension is itself a fact worth recording) and values are bounded; a
 * truncation is MARKED rather than silently cut, so a reader can never mistake a
 * clipped list for the whole selection. A nested object is replaced by its type
 * rather than walked: the legal vocabulary is strings, arrays of strings,
 * numbers and booleans, so anything else is already not a selector the trail needs
 * to reproduce.
 */
function boundedSelector(selector: Record<string, unknown>): Record<string, unknown> {
  const clip = (value: string): string =>
    value.length > AUDIT_FILTER_VALUE_MAX_CHARS
      ? `${value.slice(0, AUDIT_FILTER_VALUE_MAX_CHARS)}…[truncated]`
      : value;

  const bound = (value: unknown): unknown => {
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, AUDIT_SELECTOR_MAX_ARRAY_ITEMS).map(bound);
      return value.length > AUDIT_SELECTOR_MAX_ARRAY_ITEMS
        ? [...kept, `…[${value.length - AUDIT_SELECTOR_MAX_ARRAY_ITEMS} more truncated]`]
        : kept;
    }
    return `[${typeof value}]`;
  };

  const entries = Object.entries(selector);
  const out: Record<string, unknown> = Object.fromEntries(
    entries.slice(0, AUDIT_SELECTOR_MAX_KEYS).map(([key, value]) => [clip(key), bound(value)]),
  );
  if (entries.length > AUDIT_SELECTOR_MAX_KEYS) {
    out['…truncated'] = `${entries.length - AUDIT_SELECTOR_MAX_KEYS} more dimensions`;
  }
  return out;
}

/**
 * The calling window a retry would actually run on: the parent's two columns
 * with `config_overrides` applied on top, for the ONE cross-field rule that
 * cannot be decided from the overrides alone.
 *
 * ── Why the override-only check is not enough ─────────────────────────────
 * `validateAgencyCampaignConfig` refuses `calling_window_start ===
 * calling_window_end`, because the dialer runtime reads that as PERMANENTLY
 * CLOSED — `nextOpenAt` returns null — so the campaign is saveable and can never
 * place a call, a support ticket whose cause is invisible on every screen.
 * `POST /campaigns` cannot produce one: both sides are in the same body and the
 * validator sees the pair.
 *
 * A retry can. `config_overrides: { calling_window_end: '09:00' }` against a
 * `09:00–17:00` parent names only `end`, so the override-only pass has nothing
 * to compare it to; the internal handler then merges it onto the parent and the
 * child never dials. Same hole the other way, overriding `start` to match the
 * stored `end`.
 *
 * This is NOT re-litigating a parent that predates a rule — the parent's window
 * is valid, and it is the OVERRIDE that makes the merged pair invalid. So only
 * the two window fields are merged; catalog, retry policy and everything else
 * stay override-only, because a parent whose stored config predates a rule must
 * stay retryable and the retry dialog offers no way to fix it.
 *
 * Key presence wins, matching `resolveInheritedBehavioralConfig`, and
 * `Object.hasOwn` for the same untrusted-object reason.
 *
 * Returns `[]` when the merged pair cannot be formed (a parent that could not be
 * read, a non-string column), because a rule that cannot be evaluated is not a
 * rule that failed — the internal handler validates on the merged config
 * regardless.
 */
function mergedCallingWindowIssues(
  parentCampaign: unknown,
  overrides: Record<string, unknown> | undefined,
): ConfigIssue[] {
  const parent = (parentCampaign && typeof parentCampaign === 'object' && !Array.isArray(parentCampaign))
    ? (parentCampaign as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = {};
  let overridden = false;
  for (const key of ['calling_window_start', 'calling_window_end'] as const) {
    if (overrides && Object.hasOwn(overrides, key)) {
      merged[key] = overrides[key];
      overridden = true;
    } else if (Object.hasOwn(parent, key)) {
      merged[key] = parent[key];
    }
  }
  // Nothing was overridden ⇒ the merged window IS the parent's, and the parent's
  // stored config is not this route's to re-litigate. Returning issues here would
  // make a campaign authored before the rule unretryable, with no affordance in
  // the retry dialog to clear it.
  if (!overridden) return [];
  return validateAgencyCampaignConfig(merged);
}

/**
 * The ceiling on the actor NAME stored beside a retry.
 *
 * This route truncates rather than refusing, and rather than leaving it to the
 * internal handler: the name is a label on an audit fact, so a long display name
 * must never be the reason a supervisor's retry does not happen. Note the
 * deliberate difference from the four lifecycle transitions on this same plugin,
 * which implement no ceiling at all ({@link AgencyCampaignTransitionRequest}) —
 * there the internal handler does the truncating and this layer only sends what
 * it knows. For a retry the ceiling sits on this side of the call, so this route
 * applies it.
 */
const RETRY_ACTOR_NAME_MAX_CHARS = 255;

/**
 * `POST /campaigns/:id/retry` — the body a BROWSER may send.
 *
 * ── `.strict()`, and the attribution fields are why ────────────────────────
 * The internal handler's request carries `agent_user_id` and `actor_name` as
 * well, and both are **this layer's facts, taken from the authenticated
 * session** — the same rule session create follows, for the same reason: a
 * browser that could name the actor could act as a colleague. Zod's default
 * `.strip()` would silently drop a body-supplied `agent_user_id`, which is
 * *safe* but says nothing; a client sending one is either confused or probing,
 * and both are worth an answer. `.strict()` makes it a 400 naming the field.
 *
 * That refusal is this layer's own and precedes any `callCore`, so
 * `errorMaskHook` leaves it alone and the field name survives to the client —
 * the ordering invariant that hook's docstring states, and the reason the parent
 * read below happens after every schema check rather than before.
 *
 * The cost of strictness, stated: a future console field lands as a 400 until
 * this schema learns it. That is the same trade `forwardAllowedQuery` takes for
 * the spine's query params and it is right for the same reason — one
 * first-party console, hand-written calls, and a silently dropped field on a
 * *create* is a campaign authored differently from the one the operator
 * described.
 *
 * ── `selector` and `config_overrides` are opaque records on purpose ────────
 * The selector's vocabulary is the dialer runtime's (`spine-filters.ts`) and it
 * is validated against the PARENT campaign's disposition catalog; the refusals
 * are the internal handler's 400s carrying field-level `details`, so they
 * survive the mask intact. Mirroring that vocabulary here would be a parallel
 * filter language, and this copy would be the one that drifts.
 * `config_overrides` is different: it goes through
 * `validateAgencyCampaignConfig` at the handler, the existing campaign-config
 * validator, not a new one.
 */
const retryCreateSchema = z.object({
  selector: z.record(z.unknown()),
  // No maximum: the dialer runtime owns the campaign schema and its `name`
  // column's ceiling, exactly as on `POST /campaigns`, which validates the field
  // not at all. The `min(1)` is the one thing an ABSENT name already handles
  // better — the internal handler defaults it to `<parent> — Retry <n>` — so an empty string can only be a
  // client bug, and it would produce a campaign with no name in the picker.
  name: z.string().min(1).optional(),
  config_overrides: z.record(z.unknown()).optional(),
  /*
   * Forwarded UNCHANGED, and never invented — the exact opposite rule to
   * `agent_user_id` two fields up, for the opposite reason. The actor must come
   * from the session because the body cannot be trusted to say who is acting;
   * the key must come from the body because only the client holds the intent it
   * identifies. A key minted here would be a fresh value on the client's second
   * attempt and would protect nothing, which is the whole trap the field exists
   * to avoid. An absent key is a legal unkeyed create.
   *
   * `z.string()` and nothing more. The internal handler owns the shape —
   * 16..64 characters of a bounded alphabet, answered as a 400 with field-level `details` that survive
   * the error mask — and a second copy of those bounds here is a second thing to
   * keep in step, on a field whose failure mode is silent duplication.
   */
  idempotency_key: z.string().optional(),
}).strict();

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignRetryRoutes(app: FastifyInstance): Promise<void> {
  // ─── Retry campaigns ──────────────────────────────────────────────────────
  //
  // A retry campaign is an ORDINARY campaign in every respect: its own roster,
  // its own pacing leader, its own lifecycle. Three columns and where its
  // contacts came from are the only things that make it a retry. So there is
  // nothing special for this route to do about pacing or lifecycle — and
  // everything below is either a pass-through or one of four duties on the
  // create that belong to this layer: the behavioral-capability assert (the
  // account's settings row), the config validation, the actor (the
  // authenticated session), and the platform audit row.

  /**
   * Flatten a retry-selector query for `callCore` — forwarding EVERY key,
   * which is the deliberate opposite of what the spine reads do.
   *
   * ── Why no allow-list here, when `forwardAllowedQuery` refuses unknowns ────
   * The selector's vocabulary is the dialer runtime's (`spine-filters.ts`) and
   * its refusals are the internal handler's: "`X` is not a retry selector
   * dimension", and — for `last_disposition` — a 400 that echoes the PARENT
   * campaign's disposition catalog, which this route has not read. Naming the
   * dimensions here would be a second copy of a vocabulary that already exists
   * once, beside the data it filters, and this copy would be the one that
   * drifts: a dimension the runtime adds would be refused here with a message
   * about this list rather than forwarded.
   *
   * The security argument that makes the spine's allow-list right does not
   * reach: nothing in this query can widen scope. The campaign is the `:id` in
   * the path, the tenant and account are headers set from the authenticated
   * session, and every refusal the handler makes carries field-level `details`
   * so it survives `errorMaskHook` intact.
   *
   * Repeats (`?state=a&state=b`) arrive as an array and are comma-joined, which
   * is the handler's other accepted spelling for the same thing, so a client
   * may use either form. A blank value is dropped rather than
   * forwarded, for the reason `forwardAllowedQuery` gives: `?last_outcome=` is
   * what a cleared form control posts, and forwarding it would turn an empty
   * filter into one that matches nothing.
   */
  const forwardRetrySelectorQuery = (query: unknown): Record<string, string> => {
    const source = (query ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      const flat = Array.isArray(value) ? value.map(String).join(',') : String(value);
      if (flat.trim().length === 0) continue;
      out[key] = flat;
    }
    return out;
  };

  /**
   * GET /proxy/agency/campaigns/:id/retry/preview — "how many contacts does this
   * selector match, and what were they?" Writes nothing.
   *
   * `agency.supervise` (`account_admin`), the same floor as the attempt spine
   * and the campaign controls next door and NOT the `agency.campaigns.read`
   * (`viewer`) that `GET /campaigns/:id` carries. `agency.supervise` is
   * different in kind rather than in floor: this read is a breakdown of how a
   * campaign's calls WENT —
   * outcomes and dispositions per cohort — which is the supervisory record, not
   * the campaign's configuration. It is also the first half of an action, and
   * splitting the preview's floor from the create's would let someone size a
   * cohort they cannot author.
   *
   * A plain pass-through otherwise. `excluded` (the DNC and invalid rows removed
   * from the match) must reach the client untouched: a supervisor who selects
   * "everything suppressed" and is shown 40 instead of 300 without being told
   * why reports it as a bug, which is the whole reason the handler computes it.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/retry/preview', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/retry/preview`,
      query: forwardRetrySelectorQuery(request.query),
    });
  });

  /**
   * POST /proxy/agency/campaigns/:id/retry — author a child campaign from a
   * cohort of this one's contacts.
   *
   * ── TWO permissions, and it is not belt-and-braces ────────────────────────
   * The act is *creating a campaign* (`agency.campaigns.write`) **and**
   * *acting on another campaign's call results* (`agency.supervise`). Both floor
   * at `account_admin` today, so naming both changes nothing about who gets in —
   * which is exactly why it has to be written down rather than simplified to
   * one. `agency.supervise` is different in KIND, not just in floor; the day
   * either floor moves, this route is still correct. Ordered supervise-first so
   * the 403 a non-supervisor sees
   * names the supervisory permission, which is the one they are actually
   * missing on a results-scoped action.
   *
   * ── The order of the checks below is load-bearing ─────────────────────────
   * Every one of this route's own 4xx comes BEFORE the first `callCore`, which
   * is the invariant `errorMaskHook` states: the hook decides by whether a
   * handler call returned THIS status this request, so a route-authored 400
   * raised after a handler 400 would be rewritten into a support-ticket message.
   * Hence: schema, then config, then actor (all this route's), then the parent
   * read, then the capability assert — which can only run 403 after a handler
   * call that returned 200, a status the hook does not consider.
   *
   * ── What this route does NOT do ───────────────────────────────────────────
   * It does not validate the selector (the dialer runtime's vocabulary), does
   * not compute or check the match size (`RETRY_MAX_SEED_ROWS`, enforced by the
   * handler, and a count fetched here would be stale by the time it was acted
   * on — the same argument the PATCH handler makes about campaign status), does
   * not enforce the generation ceiling, and does not seed anything. Seeding is
   * one transaction in the handler: seeding from here would split it into many
   * calls with partial-failure states, and a half-seeded retry campaign looks
   * startable and dials a subset nobody chose.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/retry', {
    preHandler: [
      requirePermission('agency.supervise'),
      requirePermission('agency.campaigns.write'),
    ],
  }, async (request, reply) => {
    const parsed = parseOr400(retryCreateSchema, request.body, reply, 'agency');
    if (!parsed) return reply;

    // Config validation. The overrides are the create route's config fields by
    // another name, so they go through the create route's validator — an
    // override must not be able to reach the handler in a shape `POST /campaigns`
    // would have refused. Note it is the OVERRIDES that are validated and not the
    // merged result: the parent's stored columns are not this route's to
    // re-litigate, and a parent whose stored config predates a validation rule
    // must still be retryable.
    const configIssues = validateAgencyCampaignConfig(parsed.data.config_overrides);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    /*
     * The actor — this layer's fact, from the session.
     *
     * `agent_user_id` is taken from the authenticated session, as on session
     * create, because a browser that could name the actor could act as a
     * colleague. Here that is a retry campaign authored in someone else's name,
     * on the one row that records who chose to re-dial 812 customers.
     *
     * ── No actor is REFUSED, unlike on start/pause/resume/stop ───────────────
     * Those four deliberately proceed unattributed, on the argument that
     * refusing the off button for want of attribution is worse than an
     * unattributed stop. Nothing about that argument survives here. Authoring a
     * campaign is not an emergency control and the handler's retry request
     * requires the actor, so the alternatives are a 400 now or the handler's 400
     * a moment later. `missing_actor` is the established spelling for it (the
     * agency `my-*` routes), so a console has one shape to key off.
     *
     * `request.user` is always the signed-in person (`sessionMiddleware` has no
     * API-key branch); the session middleware refuses a request with no user
     * first in practice, so this is a backstop.
     */
    const actorUserId = request.user?.id;
    if (!actorUserId) {
      return reply.code(400).send({
        error: 'Validation failed',
        code: 'missing_actor',
        message:
          'Creating a retry campaign must be attributed to a user. Sign in as a supervisor.',
      });
    }

    /*
     * The parent read, which is doing two jobs at once and both are required.
     *
     *  1. OWNERSHIP. `requirePermission` proves the caller's role and never
     *     looks at the target row, so without this a supervisor could pass
     *     another tenant's campaign id. The handler's `requireOwned` answers 404
     *     for a campaign in another tenant or account and that status is
     *     forwarded unchanged — a cross-tenant id and a nonexistent one must stay
     *     indistinguishable, or the response is a campaign-id oracle.
     *  2. The INHERITED CONFIG for the capability assert below.
     *
     * ── A failure must NOT degrade to "proceed" ──────────────────────────────
     * Proceeding without the parent's config would mean creating a campaign
     * whose recording and analysis settings were never checked against this
     * account's settings, which is precisely what the capability assert exists
     * to prevent. So a throw from `callCore` (only a wiring defect) is left to
     * propagate — the error mask turns it into a 500 with a request id and a
     * full log line, and nothing was created.
     *
     * The actor's name lookup is started first and runs alongside it: it is
     * independent of the parent and never rejects (a failure or a timeout is an
     * id-only actor), so it cannot change which answer this route gives — only
     * shorten the wait for it. A request the gates below refuse discards the name.
     */
    const actorNameLookup = resolveActorDisplayName(request, actorUserId);
    const parent = await fetchOwnedCoreCampaign(request, request.params.id);
    if (!parent.ok) return reply.code(parent.status).send(parent.body);

    // The behavioral capabilities, on a route that sends no config of its own.
    // See `resolveInheritedBehavioralConfig` for why the merged parent config is
    // the only input on which this gate can fail, and why asserting against the
    // request body here would be a check that passes by construction.
    const effectiveConfig = resolveInheritedBehavioralConfig(
      parent.body,
      parsed.data.config_overrides,
    );
    //
    // The target is the PARENT campaign's own `tenant_id` / `account_id`, read off
    // the parent row just returned: the child is created in the parent's account,
    // so that account's settings row is the one that decides. Read defensively
    // like every other field of the handler's body; a missing id reaches the gate
    // as a missing target and fails closed. The object asserted is the effective
    // inherited config the handler will create the child with (the parent's values
    // with exactly `parsed.data.config_overrides`, the object forwarded below, on
    // top).
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, effectiveConfig, {
      tenantId: stringField(parent.body, 'tenant_id'),
      accountId: stringField(parent.body, 'account_id'),
    }))) return;

    // Config validation, second half — the one cross-field rule that needs the
    // parent. See `mergedCallingWindowIssues`. Safe to raise this route's 400 here
    // even though it follows a handler call: `errorMaskHook` rewrites a status
    // only when a handler call returned THAT status this request, and the parent
    // read returned 200.
    const windowIssues = mergedCallingWindowIssues(parent.body, parsed.data.config_overrides);
    if (windowIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(windowIssues) });
    }

    // Started beside the parent read above. Its failure never reaches the caller:
    // a missing name attributes the retry by id alone, exactly as the lifecycle
    // transitions do.
    const actorName = await actorNameLookup;

    /*
     * The body the handler receives is BUILT here from validated fields plus
     * facts the session authenticated — never `request.body` spread and patched. `.strict()`
     * on the schema already refuses a client-supplied `agent_user_id`, so this is
     * the second of two independent reasons the actor cannot be forged; the
     * rebuild is the one that would still hold if the schema were ever loosened.
     *
     * `actor_name` is OMITTED rather than sent empty when there is no name —
     * the handler reads `''`, `'system'` and `'unknown'` as real actors — and
     * truncated to the ceiling rather than refused, because a long display name
     * must never be why a retry does not happen.
     *
     * Note the field is `agent_user_id`, not the `actor_user_id` the four
     * lifecycle transitions on this same plugin send. Two spellings for one idea
     * on one plugin is unfortunate and it is the handler's, not a choice made
     * here: the retry handler and session create both read `agent_user_id`. Do
     * not "tidy" this to match its neighbours — the field is dropped by the
     * handler's schema if it is misspelled, and the failure is a 400 with no clue
     * in it.
     */
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/retry`,
      body: {
        selector: parsed.data.selector,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.config_overrides
          ? { config_overrides: parsed.data.config_overrides }
          : {}),
        agent_user_id: actorUserId,
        ...(actorName
          ? { actor_name: actorName.slice(0, RETRY_ACTOR_NAME_MAX_CHARS) }
          : {}),
        // Absent stays absent: an unkeyed create is legal, and sending `null`
        // where the client sent nothing would be this route having an opinion
        // about a field it deliberately does not own.
        //
        // PRESENCE, not truthiness. `z.string().optional()` accepts `""`, and
        // `""` is falsy — so a truthiness check drops it and the handler sees an
        // UNKEYED create. A client that sends `idempotency_key: ""` (an empty
        // form field, a defaulted string, a retry of a failed parse) would then
        // get a legal create, and repeating the request would build a SECOND
        // campaign over the same cohort and dial it again. That is precisely
        // the failure this field exists to prevent, wearing the shape of
        // protection. `undefined` is the only absent value; `null` is already a
        // 400 here (the field is not `.nullable()`), and `""` belongs to the
        // handler, which answers 400 with `details.idempotency_key` — a shape that
        // survives the error mask.
        ...(parsed.data.idempotency_key !== undefined
          ? { idempotency_key: parsed.data.idempotency_key }
          : {}),
      },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });

    /*
     * ── A REPLAY files no activity row ──────────────────────────────────────
     *
     * The handler answers `200` with `idempotent_replay: true` when the key had already
     * created a campaign: nothing was created by this request. A second
     * `agency_campaign.retry_created` on the parent's trail would assert that a
     * cohort was selected and re-dialled twice — precisely the thing the key
     * exists to guarantee did not happen, written into the store a compliance
     * reviewer opens to establish that it did not. The response still carries the
     * campaign, so the console is unaffected.
     *
     * Read defensively off an unknown body, like every other field here: an
     * absent flag reads as "this was a create".
     */
    const replayed = (result.body as { idempotent_replay?: unknown } | null)
      ?.idempotent_replay === true;

    if (result.status < 400 && !replayed) {
      /*
       * The activity row.
       *
       * ── Filed against the PARENT, and that is the decision worth stating ───
       * A row carries one `campaign_id`, so it appears on one campaign's trail.
       * The child's creation is already recorded on the child, by the handler, as
       * `agency_campaign.created`; what nothing else records is that a cohort of
       * THIS campaign's results was selected and re-dialled, which is a fact
       * about this campaign and belongs on the trail a compliance reviewer opens
       * when asking what was done with its call outcomes. `child_campaign_id` in
       * the detail is the link across, and the child row's own
       * `parent_campaign_id` is the link back.
       *
       * The selector is recorded here as well as frozen on the child row
       * because they answer different questions: the child's copy explains its
       * roster, and this one explains the operator's intent at the moment they
       * had it, on a store the child's deletion cannot take with it.
       *
       * Every field the handler supplies is narrowed defensively before it is
       * read — this layer keeps no campaign schema, and a malformed response must
       * never throw out of an audit call and take a successful create down with
       * it (`stringField`'s rule).
       */
      const body = (result.body && typeof result.body === 'object' && !Array.isArray(result.body))
        ? (result.body as Record<string, unknown>)
        : {};
      const childCampaignId = stringField(body['campaign'], 'id');
      const seeded = body['contacts_seeded'];
      // Normally 0 and then omitted. A retry seeds fewer rows than the preview
      // matched when the parent held byte-identical roster rows, which the child
      // collapses — so a non-zero value here is the ONLY explanation on this
      // trail for a campaign smaller than the number the supervisor approved.
      const collapsed = body['duplicates_collapsed'];
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...resolvedUserAuditActor(request, actorUserId),
        action: 'agency_campaign.retry_created',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: {
          campaign_id: request.params.id,
          parent_campaign_id: request.params.id,
          ...(childCampaignId ? { child_campaign_id: childCampaignId } : {}),
          ...(typeof seeded === 'number' ? { contacts_seeded: seeded } : {}),
          ...(typeof collapsed === 'number' && collapsed > 0
            ? { duplicates_collapsed: collapsed }
            : {}),
          // Bounded, not copied whole — see `boundedSelector`. The intent is what
          // this row is for; an unbounded caller-controlled value on a trail
          // nothing purges is what the export path already had to fix.
          selector: boundedSelector(parsed.data.selector),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * GET /proxy/agency/campaigns/:id/lineage — the whole chain, root first.
   *
   * `agency.campaigns.read` (`viewer`), the same floor as `GET /campaigns/:id`
   * and deliberately NOT the `agency.supervise` its two retry siblings above
   * carry. Lineage is NAVIGATION, not results: names, statuses, generations and
   * contact totals — every field of which a `viewer` can already read one at a
   * time by fetching each campaign. Flooring it higher would mean a viewer could
   * open a retry campaign and not be told what it was a retry of, which reads as
   * missing data rather than as a permission boundary.
   *
   * A campaign in no chain answers with itself as the only entry, not a 404 —
   * the handler's rule, and the reason the console can render the strip unconditionally.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/lineage', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/lineage`,
    });
  });
}
