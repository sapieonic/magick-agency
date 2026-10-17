/*
 * Retry campaigns: the preview, the create and the lineage. Part of
 * `agency-campaigns.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { getTenantId, getAccountId, getOriginator } from '../../middleware/auth.middleware.js';
import { auditLogger } from '../../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import { parseRetrySelector } from '../../../agency/spine-filters.js';
// The two bounds this route enforces. Imported from
// the leaf module rather than spelled here, so the number the 409 message names and
// the number the transaction refuses on are the same token.
import {
  RETRY_IDEMPOTENCY_KEY_MAX,
  RETRY_IDEMPOTENCY_KEY_MIN,
  RETRY_IDEMPOTENCY_KEY_PATTERN,
  RETRY_INHERITED_CONFIG_KEYS,
  RETRY_MAX_GENERATION,
  RETRY_MAX_SEED_ROWS,
} from '@magick-agency/domain/retry-campaign-bounds';
import type { AgencyCampaignConfigColumns } from '../../../db/models/agency.model.js';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';
// The two `last_transition_by_*` columns folded into the one wire object. Every
// route here that serves a campaign row goes through it, so the fold has one
// definition — see its header for why it is derived from the record rather than
// an allow-list.
import { formatAgencyCampaignResponse } from '../../responses/agency-campaign.response.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
import { abandonAnnouncementRejected, analysisProfileRejected, callerIdsIssue, campaignOf, configRejected, ownedCampaign } from './guards.js';
import { ACTOR_NAME_MAX, ACTOR_USER_ID_MAX } from './lifecycle.js';

const log = createChildLogger({ component: 'agency-campaign-routes' });

/**
 * `agency_campaigns.name`'s column width.
 *
 * Its own constant rather than a reuse of {@link ACTOR_NAME_MAX}, which happens to
 * be the same number for an unrelated reason: that one mirrors `audit_logs.actor`,
 * and the two would have to be changed independently. The retry create is the only
 * route that generates a name rather than receiving one, so it is the only one that
 * can overflow the column without a caller having typed anything that long.
 */
const CAMPAIGN_NAME_MAX = 255;

/*
 * SIP is not supported, and there is no `sip_connection_id` column (not in the
 * baseline schema, `AgencyCampaignRecord` or the repository's INSERT). The shared leaf
 * list `RETRY_INHERITED_CONFIG_KEYS` still names it, so the retry create reads its
 * config keys from this filtered copy: the child inherits every other key, and an
 * override naming `sip_connection_id` is refused as "not a campaign config field" — the
 * same 400 any other non-config key gets — instead of being accepted and silently dropped
 * by the repository.
 */
const RETRY_CONFIG_KEYS = RETRY_INHERITED_CONFIG_KEYS.filter(
  (key): key is Exclude<(typeof RETRY_INHERITED_CONFIG_KEYS)[number], 'sip_connection_id'> =>
    key !== 'sip_connection_id',
);

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignRetryRoutes(app: FastifyInstance): Promise<void> {
  // ── Retry campaigns ───────────────────────────────────────────────────────
  //
  // A supervisor narrows the Contacts tab until it shows the rows they mean,
  // presses "Retry these contacts", and the filter they were already looking at
  // becomes the selector for a NEW campaign seeded from those rows (never a
  // mutation of the parent — that would destroy the first pass's record and merge
  // two passes' billing under one `campaign_id`).
  //
  // All three routes are on THIS plugin, which is what gives them auth, the
  // feature gate and `requireOwned`'s tenant/account scoping. Auth middleware is
  // registered per route plugin rather than globally, so a route on a sibling
  // plugin inherits nothing. Getting it wrong here would ship an unauthenticated
  // endpoint that WRITES A DIALABLE ROSTER.
  //
  // Gated like every other read and create here: none of the reasoning that
  // ungates `/stop` and `/pause` applies — a retry create increases dialing.

  /**
   * The config columns a retry inherits from its parent, and therefore
   * exactly the keys `config_overrides` may name.
   *
   * "The same campaign again, for a subset" is the request, so the child inherits
   * how the parent dials: caller IDs, provider, window, days, timezone, wrap-up,
   * retry policy, disposition catalog, context display, break reasons, recording,
   * analysis profile, apology clip, abandonment ceiling.
   *
   * Derived by listing the keys of {@link AgencyCampaignConfigColumns} rather than
   * by a second hand-written array, so a column added to that `Pick` cannot be
   * inherited-but-not-overridable (or the reverse). The `satisfies` is what makes
   * a missing key a build error rather than a silently un-overridable field.
   */

  /**
   * Actor for the retry, from the authenticated session the public API layer
   * forwards.
   *
   * The wire key is `agent_user_id`, not `actor_user_id`: that is the spelling every
   * agency handler uses (session create and all four attempt actions), and the
   * contract keeps it. The truncate/drop rule
   * is `readTransitionActor`'s, unchanged and for the same reasons — a NAME is
   * read, so losing its tail is cosmetic; an ID is an identity, so a truncated one
   * would attribute the creation to a DIFFERENT human, and `null` ("we do not know
   * who") is the only answer that cannot mislead.
   *
   * **Optional, and the create is never refused for want of it.** `POST /` records
   * no actor at all, and a 400 here would make the feature unreachable for any
   * caller that sends none — the same argument `AgencyCampaignTransitionRequest`
   * makes at length. The public API layer supplies it on every call, so an
   * unattributed retry means a caller that did not.
   */
  function readRetryActor(body: unknown): AgencyCampaignActor | null {
    const raw = (body ?? {}) as { agent_user_id?: unknown; actor_name?: unknown };
    const userId = typeof raw.agent_user_id === 'string' ? raw.agent_user_id.trim() : '';
    if (!userId) return null;
    if (userId.length > ACTOR_USER_ID_MAX) {
      // Length only — never the value. An actor id is a user identifier, and
      // logs have no business holding one.
      log.warn(
        { length: userId.length, max: ACTOR_USER_ID_MAX },
        'Retry actor id exceeds the column width — recording the creation unattributed',
      );
      return null;
    }
    const name = typeof raw.actor_name === 'string' ? raw.actor_name.trim() : '';
    return { user_id: userId, name: name ? name.slice(0, ACTOR_NAME_MAX) : null };
  }

  /**
   * The caller's idempotency key, validated — or the reason it is refused.
   *
   * ── Why this is a 400 and never a silent drop ──────────────────────────────
   *
   * A malformed key that were quietly ignored would produce a campaign with NO
   * replay protection while the client believes it has some — and the client's
   * next act, on a lost response, is to press the button again. That is the exact
   * double-dial the idempotency key exists to prevent, reached by way of a leniency.
   * So a key that is present and unusable refuses the whole request; only an
   * ABSENT key means "unkeyed create", which is a legitimate request.
   *
   * `null` is treated as absent rather than refused: the public API layer forwards
   * the field as received, and a client serialising an unset optional as `null`
   * means the same thing as omitting it. An empty or whitespace-only string is
   * NOT absent — the client tried to send a key and sent nothing — and is refused
   * with the rest.
   */
  function readIdempotencyKey(
    body: Record<string, unknown>,
  ): { ok: true; key: string | null } | { ok: false; message: string } {
    const raw = body['idempotency_key'];
    if (raw === undefined || raw === null) return { ok: true, key: null };
    if (typeof raw !== 'string') {
      return { ok: false, message: 'must be a string, or omitted' };
    }
    // Trimmed before every check, so a key that round-tripped through a form
    // field cannot differ from itself by a trailing space — two spellings of one
    // intent is two campaigns, which is the failure this field prevents.
    const key = raw.trim();
    if (key.length < RETRY_IDEMPOTENCY_KEY_MIN || key.length > RETRY_IDEMPOTENCY_KEY_MAX) {
      return {
        ok: false,
        message: `must be ${RETRY_IDEMPOTENCY_KEY_MIN}-${RETRY_IDEMPOTENCY_KEY_MAX} characters — a UUID minted once per retry dialog is the intended value`,
      };
    }
    if (!RETRY_IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        message: 'may contain only letters, digits and `-` `_` `.` `:`',
      };
    }
    return { ok: true, key };
  }

  /**
   * `<parent> — Retry <n>`, clipped to the column.
   *
   * `agency_campaigns.name` is `VARCHAR(255)` and a parent name can already be
   * 255 characters, so the suffix has to come out of the parent's share rather
   * than being appended to it — `22001 value too long` here would fail the create
   * on a name the operator never typed. The suffix is kept whole and the parent's
   * name is what gives way, because the suffix is the part that says which pass
   * this is.
   */
  function defaultRetryName(parentName: string, generation: number): string {
    const suffix = ` — Retry ${generation}`;
    const room = CAMPAIGN_NAME_MAX - suffix.length;
    return `${parentName.slice(0, room)}${suffix}`;
  }

  // ── GET /api/v1/agency-campaigns/:id/retry/preview ────────────────────────
  //
  // Query string = the selector. Writes nothing. Shares ONE parser and ONE
  // predicate builder with the create below, because a preview that promises a
  // count the commit does not deliver is the class of defect
  // `ABANDONED_ATTEMPT_PREDICATE_SQL`'s single-definition rule exists to prevent —
  // and it is invisible, since both numbers look plausible.
  //
  // Deliberately does NOT refuse an empty or over-cap selection: reporting them is
  // the entire job of a preview. `retry_generation` and `max_seed_rows` are on the
  // payload so the console can warn about both before the supervisor commits.
  app.get<{ Params: { id: string } }>('/:id/retry/preview', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);

    // The PARENT's catalog, which is the vocabulary the seeding predicate will run
    // against — a code the parent's agents used but the child's catalog will not
    // have is still a legitimate thing to select on.
    const parsed = parseRetrySelector(
      (request.query ?? {}) as Record<string, unknown>,
      { catalog: campaign.disposition_catalog ?? [] },
    );
    if (!parsed.ok) {
      return replyValidationFailed(reply, parsed.issues);
    }

    const preview = await agencyCampaignRepository.retryPreview(campaign.id, parsed.filters);
    // Only reachable if the campaign was deleted between `requireOwned` and this
    // read. 404 rather than a zeroed preview, which would read as "there is nobody
    // left to retry" — a fact about the campaign rather than about its absence.
    if (!preview) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    return reply.send(preview);
  });

  // ── POST /api/v1/agency-campaigns/:id/retry ───────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/retry', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const parent = campaignOf(request);

    // First, because it is a property of the campaign named in the PATH and needs
    // no body at all — the same reason `transition` checks the status guard before
    // it looks at the roster. A scripted loop cannot build an unbounded chain, and
    // a deep chain is what makes both the lineage strip and the agent's history
    // read expensive.
    if (parent.retry_generation >= RETRY_MAX_GENERATION) {
      return reply.code(409).send({
        error: 'Too Many Retries',
        code: 'retry_generation_exceeded',
        message: `This campaign is already retry ${parent.retry_generation} of its chain, and ${RETRY_MAX_GENERATION} is the limit. Start a new campaign instead.`,
      });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const retryActor = readRetryActor(body);

    // Read early — before the selector, the overrides and the config validation —
    // because a refused key must cost nothing, and because the fast path below it
    // is the whole point: an ordinary retry-after-a-lost-response should not scan
    // the parent's roster at all.
    const idempotency = readIdempotencyKey(body);
    if (!idempotency.ok) {
      return replyValidationFailed(reply, { idempotency_key: idempotency.message });
    }

    const rawSelector = body['selector'];
    if (rawSelector !== undefined
      && (rawSelector === null || typeof rawSelector !== 'object' || Array.isArray(rawSelector))) {
      return replyValidationFailed(reply, { selector: 'must be an object of retry selector dimensions' });
    }
    // `?? {}` rather than a required-field check: an absent selector and an empty
    // one mean the same thing to the operator, and `parseRetrySelector` already has
    // the message that explains what to do about it (and names the deliberate way
    // to ask for the whole roster).
    const parsed = parseRetrySelector(
      (rawSelector ?? {}) as Record<string, unknown>,
      { catalog: parent.disposition_catalog ?? [] },
    );
    if (!parsed.ok) {
      return replyValidationFailed(reply, parsed.issues);
    }

    // ── Config: inherit from the parent, then patch ─────────────────────────
    const rawOverrides = body['config_overrides'];
    if (rawOverrides !== undefined
      && (rawOverrides === null || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides))) {
      return replyValidationFailed(reply, { config_overrides: 'must be an object of campaign config fields' });
    }
    const overrides = (rawOverrides ?? {}) as Record<string, unknown>;

    // An unknown override key is REFUSED, not ignored. Silently dropping one
    // produces a campaign configured differently from what the operator asked for,
    // with a 201 saying it worked — and the whole point of the overrides is that
    // the retry runs on adjusted caller IDs or an adjusted window. `status` and
    // the lifecycle columns land here too, which is the right answer: they are not
    // config, and a retry child is always created at `draft`.
    const unknownKeys = Object.keys(overrides).filter(
      (key) => !(RETRY_CONFIG_KEYS as readonly string[]).includes(key),
    );
    if (unknownKeys.length > 0) {
      return replyValidationFailed(reply, Object.fromEntries(unknownKeys.map((key) => [
        key,
        `${key} is not a campaign config field — a retry inherits everything else from its parent, and its name is set with \`name\``,
      ])));
    }

    if ('caller_ids' in overrides) {
      const issue = callerIdsIssue(overrides['caller_ids']);
      if (issue) {
        return replyValidationFailed(reply, { caller_ids: issue });
      }
      overrides['caller_ids'] = (overrides['caller_ids'] as string[]).map((id) => id.trim());
    }

    // ── Validated exactly as a PATCH is, and that is the deliberate choice ──
    //
    // The body under validation is the OVERRIDES and the base is the STORED
    // PARENT, so the cross-field window rule is evaluated on the effective result
    // — `{ calling_window_start: '20:00' }` alone is checked against the parent's
    // end time, not against nothing. It is the same helper `POST /` and `PATCH`
    // use, so a retry refuses every body those would refuse.
    //
    // ⚠️ What this does NOT do is re-validate the INHERITED values, and that is
    // the trade rather than an oversight. Re-running `analysisProfileRejected` /
    // `abandonAnnouncementRejected` over a merged config would make a retry
    // refusable for reasons that have nothing to do with the retry — a tenant
    // whose `agency_call_analysis` flag has since been turned off, or whose
    // announcement was deleted, could not retry ANY campaign that names one, and
    // the retry dialog offers no affordance to clear it. The child inherits
    // exactly what the parent is already running with, and the layer that owns
    // "should this tenant still be allowed to run that config" is the public API
    // layer's retry route, which runs `assertBehavioralCapabilitiesForConfig` over
    // `resolveInheritedBehavioralConfig`'s merged result. Guarded on PRESENCE below
    // for the same reason `PATCH` guards: a request that does not mention the
    // profile must not 403 over it.
    if (configRejected(reply, overrides, parent)) return reply;
    if ('abandon_announcement_id' in overrides
      && await abandonAnnouncementRejected(request, reply, overrides['abandon_announcement_id'])) return reply;
    if ('analysis_profile_id' in overrides
      && await analysisProfileRejected(request, reply, overrides['analysis_profile_id'])) return reply;

    const generation = parent.retry_generation + 1;
    const requestedName = typeof body['name'] === 'string' ? body['name'].trim() : '';
    // Truncated rather than refused, and rather than left to Postgres. `POST /`
    // passes a name straight through, so a 256-character one raises `22001 value
    // too long` and surfaces as a 500 on a request that is merely long — a small
    // divergence, in the direction of the same rule `readTransitionActor` applies
    // to `actor_name`: a display string is read, so losing its tail is cosmetic.
    const name = requestedName
      ? requestedName.slice(0, CAMPAIGN_NAME_MAX)
      : defaultRetryName(parent.name, generation);

    const inherited = Object.fromEntries(
      RETRY_CONFIG_KEYS.map((key) => [key, parent[key]]),
    ) as AgencyCampaignConfigColumns;

    const result = await agencyCampaignRepository.retryFromCampaign({
      parent,
      name,
      selector: parsed.filters,
      config: { ...inherited, ...overrides } as AgencyCampaignConfigColumns,
      // The originator header, exactly as `POST /` records it. The ACTOR — a
      // user id — goes on the audit row below rather than into `created_by`, which
      // holds an origination LABEL (a client hint) and not a user id on every other
      // campaign in the table.
      createdBy: getOriginator(request) ?? null,
      idempotencyKey: idempotency.key,
    });

    // Nothing was created in either refusal — the transaction rolled back before
    // the campaign INSERT. That is the point of both: a supervisor cannot delete a
    // campaign (there is no campaign delete route), so a draft that exists
    // only to be abandoned is a worse outcome than a 409 they can act on.
    if (result.status === 'empty') {
      return reply.code(409).send({
        error: 'No Contacts',
        code: 'retry_selection_empty',
        message: result.excluded.dnc + result.excluded.invalid > 0
          ? `That selection matched no contacts this campaign can retry — ${result.excluded.dnc} were on the DNC list and ${result.excluded.invalid} were invalid numbers, which are never retried. Widen the selection.`
          : 'That selection matched no contacts on this campaign. Widen the selection and try again.',
      });
    }
    if (result.status === 'too_large') {
      return reply.code(409).send({
        error: 'Selection Too Large',
        code: 'retry_selection_too_large',
        message: `That selection matched ${result.matched} contacts and a retry campaign can seed at most ${RETRY_MAX_SEED_ROWS}. Narrow the selection.`,
      });
    }

    // ── A replay: nothing happened now, and the answer says so ───────────────
    //
    // 200, not 201, because no campaign was created by THIS request — and the
    // campaign returned is the ORIGINAL, so a console that lost a 201 and pressed
    // the button again lands on the campaign it already made instead of building
    // a second one over the same cohort. `idempotent_replay` is on both arms so a
    // client reads one field rather than inferring intent from a status code.
    //
    // `contacts_seeded` and `excluded` are explicitly `null`, never the child's
    // `contacts_total`: those two describe what THIS request seeded and excluded,
    // and this request seeded nothing. Reporting the roster size in a field named
    // "seeded" would be a fabricated fact about a transaction that never ran, and
    // the roster may since have been added to by another path.
    //
    // No audit row, deliberately. The trail already carries the creation, and a
    // second `agency_campaign.created` for one campaign would make the audit read
    // — which is what an operator uses to establish that a campaign was made once
    // — assert precisely the thing this feature exists to guarantee did not happen.
    if (result.status === 'replayed') {
      log.info(
        { campaignId: result.campaign.id, parentCampaignId: parent.id },
        'Retry idempotency key already spent — returning the campaign it created',
      );
      return reply.code(200).send({
        campaign: formatAgencyCampaignResponse(result.campaign),
        idempotent_replay: true,
        contacts_seeded: null,
        excluded: null,
      });
    }

    // Same shape as `agency_campaign.created`'s, because that is what happened: a
    // retry is an ordinary campaign in every respect and belongs in the
    // trail as a creation rather than under a second event type nothing reads.
    // The lineage facts ride in `event_data`, alongside the actor the caller sent —
    // which has nowhere else to go, since `created_by` holds the originator label
    // for every other campaign and would change meaning if it held a user id here.
    auditLogger.log({
      tenantId: result.campaign.tenant_id, accountId: result.campaign.account_id,
      eventType: 'agency_campaign.created', eventCategory: 'call', severity: 'info',
      actor: getOriginator(request) ?? 'system:api',
      eventData: {
        campaign_id: result.campaign.id,
        name: result.campaign.name,
        parent_campaign_id: parent.id,
        retry_generation: generation,
        contacts_seeded: result.contacts_seeded,
        // Only when it happened. A `0` on every row is noise in a trail that is
        // read by eye; a non-zero one explains a roster smaller than the preview.
        ...(result.duplicates_collapsed > 0
          ? { duplicates_collapsed: result.duplicates_collapsed }
          : {}),
        ...(retryActor ? { actor_user_id: retryActor.user_id, actor_name: retryActor.name } : {}),
      },
    });

    return reply.code(201).send({
      campaign: formatAgencyCampaignResponse(result.campaign),
      idempotent_replay: false,
      contacts_seeded: result.contacts_seeded,
      // Normally 0. Reported because the preview's `matched` is a PROMISE about
      // this commit, and a supervisor handed fewer contacts than they were shown
      // cannot otherwise tell a duplicate collapse from rows lost to a bug — the
      // difference between "carry on" and "raise a ticket".
      duplicates_collapsed: result.duplicates_collapsed,
      excluded: result.excluded,
    });
  });

  // ── GET /api/v1/agency-campaigns/:id/lineage ──────────────────────────────
  //
  // The whole chain, root first. A campaign that is not part of any chain answers
  // with ITSELF as the only entry rather than a 404 — the supervisor's header
  // renders this strip unconditionally, and a 404 would make the console branch on
  // a distinction the payload already carries in its length.
  //
  // Serves the campaign-descriptive columns only. Not `retry_selector`, not the
  // config, not stats: the strip is navigation, and `GET /:id` already answers
  // everything else about any entry the reader clicks.
  app.get<{ Params: { id: string } }>('/:id/lineage', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);

    const lineage = await agencyCampaignRepository.campaignLineage(
      getTenantId(request), getAccountId(request), campaign.id,
    );
    // Only reachable if the campaign was deleted between the two reads —
    // `campaignLineage` resolves a chain of one for a campaign with no retries.
    if (!lineage) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    return reply.send(lineage);
  });
}
