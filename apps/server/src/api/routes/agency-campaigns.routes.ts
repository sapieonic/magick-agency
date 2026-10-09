import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, getTenantId, getAccountId, getOriginator } from '../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { auditLogger } from '../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
} from '../../db/repositories/agency.repository.js';
import {
  clampLimit,
  parseAttemptFilters,
  parseContactFilters,
  parseRetrySelector,
} from '../../agency/spine-filters.js';
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
import { decodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import { announcementRepository } from '@magick-agency/db/repositories/announcement.repository';
import { preflightAnalysisProfile } from '../../analysis/profile-preflight.js';
import type { AgencyCampaignConfigColumns, AgencyCampaignRecord } from '../../db/models/agency.model.js';
import type {
  AgencyCampaignActor,
  AgencyCampaignStats,
  AgencyCampaignStatsSeries,
  AgencyAttemptRow,
} from '@magick-agency/contracts/agency';
// The two `last_transition_by_*` columns folded into the one wire object. Every
// route here that serves a campaign row goes through it, so the fold has one
// definition — see its header for why it is derived from the record rather than
// an allow-list.
import { formatAgencyCampaignResponse } from '../responses/agency-campaign.response.js';
// The trend line's query parser. Its own module, and a thin one: the bucket
// vocabulary, the 92-day cap and the date rules are all imported there rather
// than re-declared.
import { parseCampaignSeriesQuery } from '../../agency/campaign-series.js';
// The agency-native call read. The `webrtc_calls` repository takes a scope, and
// this plugin reads under `'agency'`.
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { formatWebRtcCallResponse } from '../responses/webrtc-call.response.js';
import { isDirectRecordingProvider } from '../../utils/recording-url-resolver.js';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { campaignHealth, RECENT_FAILURE_WINDOW_MINUTES } from '../../agency/campaign-health.js';
import { resolveCallingWindow, callingWindowState, nextWindowOpen } from '../../agency/calling-hours.js';
import type { AccountConcurrencyGuard } from '../../core/account-concurrency-guard.js';
import {
  CAMPAIGN_CONFIG_COLUMN_DEFAULTS,
  issuesToDetails,
  validateAgencyCampaignConfig,
} from '../../agency/campaign-config.js';

const log = createChildLogger({ component: 'agency-campaign-routes' });

/**
 * Route params reaching a `::uuid` cast are shape-checked first.
 *
 * Postgres answers `22P02 invalid input syntax for type uuid` on a malformed
 * one, which the error handler turns into a 500 — so a bad request would look
 * like a broken service on a read route. A 404 is both the honest status and the
 * one that keeps a nonexistent id indistinguishable from a forbidden one.
 */
const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Column widths for the lifecycle actor, so the route can handle
 * an over-long value rather than letting Postgres raise `22001 value too long`.
 *
 * That error would fail the TRANSITION — a supervisor losing the Stop button
 * because a string was long — so neither value may reach the column unchecked.
 * `readTransitionActor` truncates the NAME and drops the ID; see its docstring for
 * why the two are handled differently. Note this is a different trade from
 * `MAX_AGENT_USER_ID_LENGTH` in `agency-agents.routes.ts`, which 400s: there the
 * over-long value is the whole subject of the request, so there is nothing left to
 * answer.
 */
const ACTOR_USER_ID_MAX = 100;
const ACTOR_NAME_MAX = 255;

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

/**
 * Campaign CRUD + lifecycle. The campaign is an EXECUTION object with one table,
 * `agency_campaigns`; the public API layer's proxy routes keep no copy of their own —
 * two writable copies of one business object is how they drift.
 *
 * **No concurrency setter appears here, deliberately.** The dialing ceiling is the
 * account's `max_concurrent_calls`, which is super-admin-only; a campaign reads it
 * and never sets it. `GET /:id/stats` reports utilisation against it read-only.
 */
/**
 * Dependencies the STATS route needs and no other route here does.
 *
 * The health strip's diagnoses need DNC availability and the account concurrency
 * counter, both of which live on objects this file has no other access to. Injected
 * the same way `agencyRoutes` receives its runtime, rather than reached through a
 * module singleton — the alternative makes every test in this file construct a
 * Redis.
 *
 * Narrowed to the two METHODS the stats strip calls, rather than to the objects
 * that own them. A test can then supply a faithful stub that type-checks on its
 * own terms, instead of casting a narrow literal through `never` — and a cast is
 * how a test ends up asserting against a permanently degraded strip without
 * anything saying so.
 */
/*
 * The two `runtime` members are typed structurally rather than as
 * `Pick<AgencyRuntime[...]>`, and `callManager` is the telephony guard host
 * (`TelephonyGuardHost`, which owns `accountConcurrencyGuard`). `dnc.appliedVersion` has
 * no Redis set behind it (decision B8): `agencyPlugin` supplies a probe of the same DNC
 * read the pre-dial gate makes, answering `null` exactly when that gate would halt — see
 * `agency/dnc-availability.ts`.
 */
export interface AgencyCampaignRouteDeps {
  runtime: {
    dnc: { appliedVersion(tenantId: string): Promise<number | null> };
    /**
     * Agent liveness for the supervisor floor's connected column.
     *
     * One method and no more, for the reason this whole interface is written in
     * methods: a test supplies a two-line stub that type-checks on its own terms
     * instead of constructing a `StationRegistry` and a Redis.
     *
     * Deliberately `connectedBySession` rather than `ownerOf` — the latter cannot
     * distinguish a Redis fault from an absent key, so it would report every agent
     * disconnected during a blip. See the method's own comment.
     */
    stations: { connectedBySession(sessionIds: readonly string[]): Promise<Map<string, boolean>> };
  };
  callManager: {
    accountConcurrencyGuard: Pick<AccountConcurrencyGuard, 'getDistributedAccountCount'>;
  };
}

/**
 * Run one strip dependency as GENUINELY best-effort.
 *
 * `.catch()` on its own only handles a *rejected* promise. A **synchronous** throw
 * while `Promise.all`'s array literal is being built — a missing `deps` (Fastify
 * passes the register options object as the second argument when a plugin is
 * registered without a wrapper closure), a getter that throws, a non-function
 * `appliedVersion` — escapes before any promise exists, so no `.catch()` is ever
 * attached and the whole route 500s. That is the one failure mode the strip's
 * best-effort contract exists to survive.
 *
 * Invoking the read INSIDE the chain lands both failure shapes on the same
 * fallback. Degraded still means a 200 with a `null`/`0` field the assembler has a
 * defined branch for — never a 500, and never a silent one either: the warn is the
 * only place a wiring mistake becomes visible, since the response looks merely
 * degraded.
 */
function bestEffort<T>(dependency: string, read: () => T | Promise<T>, fallback: T): Promise<T> {
  return Promise.resolve()
    .then(read)
    .catch((err: unknown) => {
      log.warn({ err, dependency }, 'Campaign stats dependency degraded — serving fallback');
      return fallback;
    });
}

/**
 * Which pending contacts are shut out of their calling window right now.
 *
 * Evaluates the REAL rule (`callingWindowState`) once per distinct timezone
 * rather than re-expressing it in SQL. A roster has a handful of distinct
 * timezones however many contacts it holds, so this is exact and cheap where a
 * per-row evaluation would not be, and — more importantly — there is still only
 * one definition of when a number may be dialled.
 *
 * `unresolvable` counts as shut out: a contact whose timezone cannot be resolved
 * is never dialled by the pre-dial gate either, so counting it as dialable would
 * make the strip claim work is available that the engine will not do.
 */
function evaluateCallingHours(
  campaign: AgencyCampaignRecord,
  pendingByTimezone: Array<{ timezone: string | null; count: number }>,
): { outsideCallingHours: number; nextWindowOpensAt: Date | null } {
  const now = new Date();
  let outside = 0;
  let soonest: Date | null = null;

  for (const group of pendingByTimezone) {
    const window = resolveCallingWindow(campaign, { timezone: group.timezone });
    if (callingWindowState(window, now) === 'open') continue;
    outside += group.count;
    const opens = nextWindowOpen(window, now);
    if (opens && (soonest === null || opens < soonest)) soonest = opens;
  }

  return { outsideCallingHours: outside, nextWindowOpensAt: soonest };
}

export async function agencyCampaignRoutes(
  app: FastifyInstance,
  deps: AgencyCampaignRouteDeps,
): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  /**
   * Every route is behind the flag — **except the two that reduce activity**.
   *
   * ── Why `/stop` and `/pause` are not gated ──────────────────────────────────
   *
   * `agency_dialer_enabled` is the kill switch, and the pacing engine honours it
   * (a running campaign is dropped within one supervise pass). But a kill switch
   * that also removes the off button is not a kill switch: with every lifecycle
   * route gated, turning the flag off would leave the campaign row stuck in
   * `running` forever, its supervisor unable to stop it, and the only way to reach
   * the Stop button being to re-enable the dialer for the whole account — i.e. to
   * turn dialing back on in order to turn it off.
   *
   * The line is **what a control does to dialing volume**, not what it is — but
   * "reduces dialing" is necessary and NOT sufficient. A control may be ungated
   * only if it also leaves the campaign in a state that reaches its own end without
   * the flag coming back, and **that half is the engine's to deliver, not this
   * file's.** Narrowing the status list below cannot deliver it: what would strand
   * a stopped campaign is not the status it came from but a pacing supervisor that
   * dropped flag-gated campaigns wholesale, leaving nothing to run `maybeFinalize`.
   * `PacingEngine` leads a `stopping` campaign regardless of the flag (dialing
   * refused at the dial site, not merely absent) and drains it on live attempts
   * rather than on the roster, so `stopping → stopped` completes on its own.
   *   - `/stop` from `running`/`paused` — reduces dialing, and the drain finishes
   *     without the flag. Ungated.
   *   - `/stop` from `draft` — REFUSED (409), see the route. Not for safety: a
   *     draft has nothing to stop, and the operator wants delete.
   *   - `/pause` — only reachable from `running`, reduces dialing, and `paused` is
   *     fully recoverable. Ungated.
   *   - `/start`, `/resume` — begin dialing for a tenant the platform believes has
   *     no dialer. Gated.
   *   - create, `PATCH`, and the reads — gated, because the flag's other job is to
   *     make the feature *absent* for a tenant who has not bought it, and a 403 on
   *     a read is the honest answer for a surface they should not see. An operator
   *     who needs to stop a campaign already holds its id (the console had it
   *     before the flag flipped), and `/stop` needs nothing else.
   */
  async function gate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
      tenantId: getTenantId(request), accountId: getAccountId(request),
    });
    if (!enabled) {
      reply.code(403).send({ error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Agency dialer is not enabled for this account.' });
      return false;
    }
    return true;
  }

  /**
   * The caller-ID pool must be a non-empty array of non-blank strings.
   *
   * **Length is not the real check.** `caller_ids: ['']` satisfies "at least one",
   * and `pickCallerId` then returns `''` — falsy, so the pacing engine takes its
   * no-caller-IDs halt and reports "has no caller IDs" about a campaign that has
   * one, which is a genuinely confusing thing to hand an operator. `caller_ids:
   * [123]` would be stored as-is and reach the dial.
   *
   * Deliberately shape-only. Ownership against the tenant's own numbers is NOT
   * validated here. Recorded rather than silently skipped.
   *
   * Returns the reason it is bad, or null when it is fine.
   */
  function callerIdsIssue(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) return 'at least one caller ID is required';
    // `.trim()` because a whitespace-only entry is the same defect as an empty one
    // and arrives from the same place — a text input or a CSV cell.
    if (!value.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return 'every caller ID must be a non-empty string';
    }
    return null;
  }

  async function requireOwned(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<AgencyCampaignRecord | null> {
    const campaign = await agencyCampaignRepository.findById(request.params.id);
    if (!campaign || campaign.tenant_id !== getTenantId(request) || campaign.account_id !== getAccountId(request)) {
      reply.code(404).send({ error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' });
      return null;
    }
    return campaign;
  }

  /**
   * Refuse a config that would be stored happily and then behave wrongly.
   *
   * **This is enforcement, not a nicety.** The public API layer's own validator
   * (`agency/agency-campaign-config.ts`) runs on its proxy path only; this one runs
   * at the write, whatever reached it. The invariants are consumed by the retry
   * engine and the calling-hours gate, so this is where they have to hold.
   *
   * Returns false only when it has already replied.
   */
  function configRejected(
    reply: FastifyReply,
    body: unknown,
    base: { calling_window_start?: string; calling_window_end?: string },
  ): boolean {
    const issues = validateAgencyCampaignConfig(body, base);
    if (issues.length === 0) return false;
    reply.code(400).send({ error: 'Validation failed', details: issuesToDetails(issues) });
    return true;
  }

  /**
   * Validate `abandon_announcement_id` at CONFIG time.
   *
   * The resolver deliberately fails quiet at dial time — a customer has already
   * answered by then, so "not found" and "not configured" take the same path and
   * neither may throw. That is right for the call and useless for the operator: it
   * means a typo'd or cross-tenant id is invisible until the first abandoned call
   * silently plays nothing. So the ownership check lives here, where a mistake is
   * a 404 someone can read, and it is **scoped** — an id belonging to another
   * tenant would otherwise be a route to playing their recorded audio to our
   * customer, since the dial-time resolver looks up by id alone.
   *
   * `null` is always accepted: it is how an operator clears the apology.
   * Returns false only when it has already replied.
   */
  async function abandonAnnouncementRejected(
    request: FastifyRequest,
    reply: FastifyReply,
    value: unknown,
  ): Promise<boolean> {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'string' || value.trim() === '') {
      reply.code(400).send({
        error: 'Validation failed',
        details: { abandon_announcement_id: 'must be an announcement id, or null to clear it' },
      });
      return true;
    }
    const announcement = await announcementRepository.findActiveByIdScoped(
      value, getTenantId(request), getAccountId(request),
    );
    if (!announcement) {
      reply.code(404).send({
        error: 'Not Found',
        code: 'announcement_not_found',
        message: 'abandon_announcement_id does not name an active announcement on this account.',
      });
      return true;
    }
    return false;
  }

  /**
   * Refuse an `analysis_profile_id` that is not this account's active profile,
   * through the shared `preflightAnalysisProfile`, so the rule has one definition.
   *
   * The campaign is the writer of that column for its legs: `agency-dialer`
   * passes `campaign.analysis_profile_id` into `createBridgedCall`, which stamps
   * it onto the leg. The end-of-call gate resolves it with the unscoped
   * `callAnalysisProfileRepository.findById` and checks the owner itself, but
   * there a foreign id is silently replaced by the account default and a
   * deactivated one is snapshotted as-is. Only a refusal here tells the operator.
   *
   * Deliberately not enforced at dial time as well: by then a customer is on the
   * line, and the honest answer to a misconfiguration is a status code the
   * operator reads at the edit, not a call that silently analyses wrong.
   *
   * Scoped `'agency'`, which is what makes this the same check the campaign's own
   * calls will get: the preflight asks `agency_call_analysis`, exactly as their
   * end-of-call gate will. Asking `dialer_call_analysis` instead would let an
   * agency-only tenant have agency analysis running while every campaign edit that
   * named a profile 403'd with "Dialer call analysis is not enabled for this
   * account."
   */
  async function analysisProfileRejected(
    request: FastifyRequest,
    reply: FastifyReply,
    value: unknown,
  ): Promise<boolean> {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'string' || value.trim() === '') {
      reply.code(400).send({
        error: 'Validation failed',
        details: { analysis_profile_id: 'must be a call-analysis profile id, or null to clear it' },
      });
      return true;
    }
    const err = await preflightAnalysisProfile(value, getTenantId(request), getAccountId(request), 'agency');
    if (err) {
      reply.code(err.status).send({ error: err.error, code: err.code, message: err.message });
      return true;
    }
    return false;
  }

  // ── POST /api/v1/agency-campaigns ────────────────────────────────────────
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const body = request.body as Record<string, unknown> | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const callerIdsError = callerIdsIssue(body?.caller_ids);

    if (!name || callerIdsError) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: {
          ...(name ? {} : { name: 'name is required' }),
          ...(callerIdsError ? { caller_ids: callerIdsError } : {}),
        },
      });
    }
    const callerIds = (body!.caller_ids as string[]).map((id) => id.trim());

    // Before the announcement lookup: this is pure and costs no round trip, and a
    // body that is going to be refused should not spend a DB read first.
    //
    // The base is the schema's COLUMN DEFAULTS, not `{}` — an omitted window
    // side becomes the default rather than nothing, so `{ calling_window_start:
    // '20:00' }` alone stores 20:00–20:00 and never dials. Validating the body in
    // isolation cannot see that, and the default path is the ordinary one.
    if (configRejected(reply, body, CAMPAIGN_CONFIG_COLUMN_DEFAULTS)) return reply;

    if (await abandonAnnouncementRejected(request, reply, body?.abandon_announcement_id)) return reply;

    if (await analysisProfileRejected(request, reply, body?.analysis_profile_id)) return reply;

    const campaign = await agencyCampaignRepository.create({
      tenant_id: getTenantId(request),
      account_id: getAccountId(request),
      name,
      caller_ids: callerIds,
      telephony_provider: body?.telephony_provider as string | undefined,
      calling_window_start: body?.calling_window_start as string | undefined,
      calling_window_end: body?.calling_window_end as string | undefined,
      calling_days: body?.calling_days as number[] | undefined,
      default_timezone: body?.default_timezone as string | undefined,
      wrapup_seconds: body?.wrapup_seconds as number | undefined,
      wrapup_auto_return: body?.wrapup_auto_return as boolean | undefined,
      retry_policy: body?.retry_policy,
      disposition_catalog: body?.disposition_catalog,
      context_display: body?.context_display,
      record_calls: body?.record_calls as boolean | undefined,
      analysis_profile_id: (body?.analysis_profile_id as string | null) ?? null,
      abandon_announcement_id: (body?.abandon_announcement_id as string | null) ?? null,
      // Omitted ⇒ the repository applies
      // `DEFAULT_ABANDONMENT_CEILING_PCT`, which is also the column's DEFAULT.
      abandonment_ceiling_pct: body?.abandonment_ceiling_pct as number | undefined,
      created_by: getOriginator(request) ?? null,
    });

    auditLogger.log({
      tenantId: campaign.tenant_id, accountId: campaign.account_id,
      eventType: 'agency_campaign.created', eventCategory: 'call', severity: 'info',
      actor: getOriginator(request) ?? 'system:api',
      eventData: { campaign_id: campaign.id, name: campaign.name },
    });
    return reply.code(201).send(formatAgencyCampaignResponse(campaign));
  });

  // ── GET /api/v1/agency-campaigns ─────────────────────────────────────────
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const q = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q?.limit ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(q?.offset ?? 0) || 0, 0);
    const { rows, total } = await agencyCampaignRepository.list(
      getTenantId(request), getAccountId(request), limit, offset,
    );
    return reply.send({
      campaigns: rows.map(formatAgencyCampaignResponse),
      total, limit, offset,
    });
  });

  // ── GET /api/v1/agency-campaigns/:id ─────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;
    return reply.send(formatAgencyCampaignResponse(campaign));
  });

  /**
   * Partial update of campaign configuration.
   *
   * PATCH only. Every field is optional and this is a partial update, which PUT
   * misdescribes, so there is deliberately no PUT alias: an alias the proxy layer
   * calls would be the real interface, not a transition, and would reach
   * customer-facing docs as one.
   *
   * `status` is deliberately NOT patchable: lifecycle goes through the four
   * transition routes, so a config edit can never race the pacing leader's
   * `running → completed` / `stopping → stopped` writes.
   */
  const patchHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    const body = { ...(request.body as Record<string, unknown> | undefined) };
    if ('status' in body) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: { status: 'status is not editable — use /start, /pause, /resume or /stop' },
      });
    }
    // Checked on the PATCH too, not just create — for the same reason as the
    // apology below: config is the thing an operator edits *after* the campaign
    // exists, so a create-only validator guards the least likely path.
    //
    // The base is the STORED campaign, so the cross-field window rule is evaluated
    // on the effective result, which is why the enforcement belongs here, beside
    // the row, rather than at the proxy route.
    // `caller_ids` is checked on PATCH as well as create, so a campaign cannot be
    // broken after the fact — and `caller_ids` is not part of
    // `validateAgencyCampaignConfig`'s remit (that validator owns the retry/window/
    // disposition invariants), so nothing else catches it. The pacing engine
    // halts on an unusable pool instead of throwing mid-tick, but a campaign that
    // silently stops dialing on a config edit is still the wrong answer: the
    // operator finds out from a dial counter that stopped moving, and the refusal
    // belongs at the edit. Same helper as create, so the two cannot drift.
    if ('caller_ids' in body) {
      const issue = callerIdsIssue(body.caller_ids);
      if (issue) {
        return reply.code(400).send({ error: 'Validation failed', details: { caller_ids: issue } });
      }
      body.caller_ids = (body.caller_ids as string[]).map((id) => id.trim());
    }

    if (configRejected(reply, body, campaign)) return reply;

    if ('abandon_announcement_id' in body
      && await abandonAnnouncementRejected(request, reply, body.abandon_announcement_id)) return reply;
    // Guarded on presence, like the apology above: a PATCH that does not mention
    // the profile must not 403 merely because `agency_call_analysis` is off.
    if ('analysis_profile_id' in body
      && await analysisProfileRejected(request, reply, body.analysis_profile_id)) return reply;
    const updated = await agencyCampaignRepository.update(campaign.id, body);
    // `update` can only return null if the row vanished between the ownership
    // check and the write — a delete racing an edit. 404 rather than serving
    // `null` as a campaign.
    if (!updated) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    return reply.send(formatAgencyCampaignResponse(updated));
  };
  app.patch<{ Params: { id: string } }>('/:id', patchHandler);

  // ── GET /api/v1/agency-campaigns/:id/stats ───────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/stats', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;
    // Two producers, one payload. The repository half is SQL over this campaign;
    // the health half needs Redis (DNC sync state, the account concurrency
    // counter) and a pure TS rule (calling hours), which is why `stats()` cannot
    // and should not reach it. `AGENCY_STATS_ROUTE_FIELDS` is the split, stated
    // once and imported by both sides.
    const [stats, health] = await Promise.all([
      agencyCampaignRepository.stats(campaign.id),
      agencyCampaignRepository.healthInputs(campaign.id),
    ]);

    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);

    // Every one of these is best-effort by design: the strip exists to explain a
    // stall, so a strip that 500s when a dependency is degraded fails at exactly
    // the moment it is needed. A failed read becomes `null`, and `null` has a
    // defined meaning in every branch of the assembler — never a guess.
    //
    // Each read is wrapped rather than merely `.catch()`-ed, because a `.catch()`
    // hung off an expression cannot catch that expression's own SYNCHRONOUS throw
    // — see `bestEffort`. The fallbacks are unchanged and the difference between
    // them is deliberate: `concurrencyLimit` falls back to `0`, which `saturated()`
    // reads as "no known ceiling" and therefore never diagnoses saturation, while
    // the other two fall back to `null`, which the assembler reads as "unknown".
    const [dncAppliedVersion, concurrencyLimit, concurrencyInUse, connected] = await Promise.all([
      bestEffort<number | null>(
        'agency.dnc.appliedVersion',
        () => deps.runtime.dnc.appliedVersion(tenantId),
        null,
      ),
      bestEffort<number>(
        'account_settings.max_concurrent_calls',
        () => accountSettingsRepository.getMaxConcurrentCalls(tenantId, accountId),
        0,
      ),
      bestEffort<number | null>(
        'concurrency.distributed_account_count',
        () => deps.callManager.accountConcurrencyGuard
          .getDistributedAccountCount(tenantId, accountId)
          .then((r) => (r.status === 'available' ? r.count : null)),
        null,
      ),
      // The floor's liveness column. One `MGET` for the whole floor, and best-effort
      // like every other strip dependency — but note what the fallback MEANS
      // here: an empty map leaves every agent `connected: null` ("unknown"),
      // never `false`. Manufacturing "disconnected" from a degraded Redis read
      // would be a confident wrong answer on the screen a supervisor acts from,
      // which is the same mistake `concurrency_in_use` avoids by falling back to
      // `null` rather than to `0`.
      //
      // In the SAME `Promise.all` as the other three, not awaited after them.
      // Its only input is `stats.agents`, already resolved well above, so there
      // is no ordering reason to serialise it — and this route is polled every
      // few seconds by the supervisor dashboard, so a separate await makes the
      // latency `max(a,b,c) + d` instead of `max(a,b,c,d)`, adding a full extra
      // round trip to every poll under exactly the Redis latency spike
      // `bestEffort` exists to absorb.
      bestEffort<Map<string, boolean>>(
        'agency.stations.connectedBySession',
        () => deps.runtime.stations.connectedBySession(stats.agents.map((a) => a.session_id)),
        new Map(),
      ),
    ]);

    const { outsideCallingHours, nextWindowOpensAt } = evaluateCallingHours(campaign, health.pendingByTimezone);

    // Annotated, not inferred. An un-annotated spread widens to whatever the
    // repository happens to return, so the response could silently omit fields the
    // contract declares required with nothing anywhere objecting. With the
    // annotation, a field NEITHER producer supplies is a compile error at the
    // seam that serves it rather than an `undefined` a consumer reads months later.
    const payload: AgencyCampaignStats = {
      campaign_id: campaign.id,
      status: campaign.status,
      ...stats,
      // Overrides the spread's `agents`, which carries every field EXCEPT this one
      // (`AGENCY_AGENT_ROUTE_FIELDS`). `?? null` is the unknown case — a session
      // missing from the map was never answered for, which is not the same as
      // having been answered `false`.
      agents: stats.agents.map((agent) => ({
        ...agent,
        connected: connected.get(agent.session_id) ?? null,
      })),
      // Contacts remaining and retries pending are genuinely different numbers —
      // `next_attempt_at` can be hours out, so "list exhausted" and "campaign
      // complete" are not the same thing and the dashboard shows both.
      concurrency_limit: concurrencyLimit,
      concurrency_in_use: concurrencyInUse,
      ...campaignHealth({
        campaign,
        stats,
        dncAppliedVersion,
        concurrencyLimit,
        concurrencyInUse,
        contactsOutsideCallingHours: outsideCallingHours,
        nextCallingWindowOpensAt: nextWindowOpensAt,
        nextRetryAt: health.nextRetryAt,
        lastDialAt: health.lastDialAt,
        recentFailures: { ...health.recent, windowMinutes: RECENT_FAILURE_WINDOW_MINUTES },
        onBreakByReason: health.onBreakByReason,
      }),
    };
    return reply.send(payload);
  });

  /**
   * ── GET /api/v1/agency-campaigns/:id/stats/series ─────────────────────────
   *
   * `?from=&to=&bucket=day|week|month`. `from` inclusive, `to` EXCLUSIVE, both
   * required, capped at the same 92 days the agent roster and the grouped read
   * enforce (`ROSTER_MAX_WINDOW_DAYS`, imported — not a second 92).
   *
   * The public API layer serves it at `/proxy/agency/campaigns/:campaignId/stats/series`.
   *
   * ── Why this is a second route and not fields on `/:id/stats` ─────────────
   *
   * `/:id/stats` is the campaign RIGHT NOW: lifetime counters, a live floor, a
   * health strip. It is polled every few seconds by the supervisor dashboard, and
   * it cannot answer "is this getting better or worse" because every counter on it
   * is a single lifetime total — which is why there is no `previous_hour` block
   * (see the note at the end of `AgencyCampaignStats`: a lifetime figure beside one
   * hour of it reads as a permanent collapse). A trend needs its own window
   * parameters, so it needs its own route; bolting a `?from=&to=` onto the live
   * payload would make the poll carry a range aggregate it does not want and make
   * the range read carry a Redis fan-out it does not need.
   *
   * ── ROUTE PRECEDENCE, tested rather than reasoned about ───────────────────
   *
   * This path has one MORE segment than `/:id/stats`, so Fastify's radix tree
   * separates them with no ambiguity. None of that is asserted by the route
   * existing, which is the point: an assertion can pass vacuously against a route
   * that does not exist, and a 404 and a wrong-handler 200 are both invisible to a
   * status-code assertion on the sibling.
   * `test/unit/agency/campaign-stats-series-route.test.ts` pins BOTH directions —
   * `/stats` still reaches the live payload, `/stats/series` reaches the series.
   *
   * ── AUTH AND THE FLAG, and why the plugin is the whole answer ─────────────
   *
   * Auth middleware is registered PER ROUTE PLUGIN, not globally, so a route on a
   * sibling plugin inherits nothing and ships unauthenticated. Being on THIS plugin
   * gives this route the `preHandler` hook, and the two lines below give it the feature
   * gate and `requireOwned`'s tenant/account scoping. All three are asserted by
   * the route test rather than trusted to this comment.
   *
   * Gated, like every other read here: the flag's other job is to make the feature
   * ABSENT for a tenant who has not bought it, and this changes nothing, so none of
   * the reasoning that ungates `/stop` and `/pause` applies.
   *
   * ── What the payload does and does not carry ──────────────────────────────
   *
   * Every bucket in the range, zeros included — a weekend is `attempts: 0`, never
   * an absent key. No rates: both halves of every rate are on every bucket and the
   * client derives them, because a chart aggregating buckets into one column needs
   * `Σnum / Σden` rather than the mean of the per-bucket rates. The `timezone` is
   * the campaign's own, RESOLVED, and it is echoed so a consumer never has to
   * guess which zone the labels were cut in. All three are argued on
   * `AgencyCampaignStatsSeries`.
   */
  app.get<{ Params: { id: string } }>('/:id/stats/series', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    const parsed = parseCampaignSeriesQuery((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }

    const series: AgencyCampaignStatsSeries | null = await agencyCampaignRepository.statsSeries(
      { tenantId: getTenantId(request), accountId: getAccountId(request) },
      campaign.id,
      parsed.filters,
    );
    // `null` means the campaign matched nothing in scope — which `requireOwned`
    // just checked, so in practice it was deleted between the two reads. 404 is the
    // same answer that check gives, rather than an empty series that would read as
    // "this campaign dialled nobody".
    if (!series) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    // The window width and the grouping, never the numbers: this is polled from a
    // chart, so the operational signal is the shape of the request.
    log.debug(
      { campaignId: campaign.id, bucket: parsed.filters.bucket, buckets: series.buckets.length },
      'Campaign stats series served',
    );
    return reply.send(series);
  });


  // ── The attempt spine's read surface ────────────────────────────
  //
  // `agency_call_attempts` is the audit spine (one row
  // per dial), and these routes are what read it. The aggregate counters on
  // `/stats` cannot answer per-number questions, and `/app/calls/dialer/history`
  // is a CALL list that structurally cannot show an attempt which never
  // connected, a suppressed contact, or a disposition. A supervisor needs not
  // only "Manas stopped the campaign at 14:22" but "we dialled this number four
  // times and Ravi marked it Not Interested" — and the second is what a
  // compliance request asks for.
  //
  // ── These are TENANT-FACING routes, and they are on the right plugin ───────
  //
  // This is campaign data, not the audit trail. It belongs beside `/stats`, with
  // the same auth, the same feature gate and the same `requireOwned` scoping.
  // Being on THIS plugin is what gives it all three: auth middleware is
  // registered per-route-plugin rather than globally, so a route on a sibling
  // plugin inherits nothing.
  //
  // Getting it wrong here would ship an unauthenticated endpoint serving every
  // customer's phone number. `test/unit/agency/spine-read-routes.test.ts` asserts
  // the middleware runs on both routes rather than trusting this comment.

  /**
   * Parse `?cursor=` into a keyset position.
   *
   * A malformed cursor is **400, not a silent reset to page one**. A list that
   * quietly restarts from the top reads as duplicate rows to a supervisor
   * scrolling through it, and there is no way to tell that from real duplicates.
   * Returns `undefined` for "no cursor supplied", `null` once it has replied.
   */
  function readCursor(
    request: FastifyRequest,
    reply: FastifyReply,
  ): AgencyKeysetPosition | null | undefined {
    const raw = (request.query as { cursor?: unknown } | undefined)?.cursor;
    if (raw === undefined || raw === null || String(raw).length === 0) return undefined;
    const decoded = decodeKeysetCursor(String(raw));
    if (!decoded) {
      reply.code(400).send({
        error: 'Validation failed',
        code: 'malformed_cursor',
        details: { cursor: 'not a cursor this API issued' },
      });
      return null;
    }
    return decoded;
  }

  // ── GET /api/v1/agency-campaigns/:id/attempts ────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/attempts', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    const parsed = parseAttemptFilters((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }
    /*
     * `?agent_user_id=` is shape-checked here. `agency_agent_sessions.agent_user_id`
     * is typed `UUID`, so a non-UUID value would reach `listForCampaign`'s
     * `agent_user_id = $n` as Postgres `22P02` — a 500 on a read route — and the
     * console's spine and CSV export both forward this filter as given (the public API
     * layer's `forwardAllowedQuery`). Refused with the parser's own 400 shape, the
     * answer `parseAttemptFilters` already gives a malformed `contact_id`.
     */
    if (parsed.filters.agentUserId !== undefined && !UUID_PARAM_RE.test(parsed.filters.agentUserId)) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: [{ param: 'agent_user_id', message: 'must be an agent id' }],
      });
    }
    const cursor = readCursor(request, reply);
    if (cursor === null) return reply;

    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: campaign.id,
      filters: parsed.filters,
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
    });
    return reply.send(page);
  });

  // ── The agency-native call read ──────────────────────────────
  //
  // Without this surface the agency workspace would have to link its attempt rows
  // to a generic call page outside `AgencyLayout`, with the campaign context and
  // the list the reader came from both gone.
  //
  // It reaches the call through the ATTEMPT, which is the right spine for it: the
  // attempt is what the reader clicked, it is campaign-scoped (so ownership is
  // already proved), and it survives the call. Reaching the call by its own id
  // would need a second ownership proof and would still have nothing to say when
  // the row is gone.
  //
  // ── Why the call is fetched separately rather than joined ──────────────────
  //
  // `agency_call_attempts.webrtc_call_id` is deliberately un-FK'd:
  // both sides are on retention purges with independent windows, so either can
  // outlive the other and a cascade in either direction would destroy the other's
  // audit trail. A join would therefore silently drop exactly the attempts whose
  // call has aged out — the rows a compliance request is most likely to be about.
  // Two reads, and the second one being empty is a fact to report rather than an
  // error.

  /** Where this surface serves an agency leg's recording bytes. */
  function agencyRecordingPath(campaignId: string, attemptId: string): string {
    return `/api/v1/agency-campaigns/${campaignId}/attempts/${attemptId}/recording`;
  }

  /**
   * The attempt, plus its call when the call is still there.
   *
   * Returns `null` once it has replied. `call` is null in two different
   * situations and `call_availability` is what tells them apart:
   *
   *  - `never_placed` — the attempt has no `webrtc_call_id`. It failed a pre-dial
   *    gate, or was abandoned before a leg was placed. There was never a call.
   *  - `purged` — there was a call and its row has aged out of retention.
   *  - `available` — the call is there.
   *
   * The distinction is not cosmetic. "We never dialled this number" and "we
   * dialled it and the recording has expired" are different answers to a
   * compliance question, and collapsing them into one empty state would make the
   * spine unable to give either.
   */
  async function readAttemptCall(
    request: FastifyRequest<{ Params: { id: string; attemptId: string } }>,
    reply: FastifyReply,
  ): Promise<{
    attempt: AgencyAttemptRow;
    call: WebRtcCallRecord | null;
    availability: 'available' | 'purged' | 'never_placed';
  } | null> {
    const campaign = await requireOwned(request, reply);
    if (!campaign) return null;

    /*
     * Checked before the query, for the same reason the contact route checks its
     * id: `findForCampaign` compares against a `uuid` column, so a malformed
     * attemptId reaches Postgres as `22P02` and the error handler turns it into a
     * 500 — a bad request that looks like a broken service on a read route. A 404
     * is both the honest status and the one that keeps a nonexistent id
     * indistinguishable from one on someone else's campaign.
     */
    if (!UUID_PARAM_RE.test(request.params.attemptId)) {
      reply.code(404).send({
        error: 'Not Found', code: 'attempt_not_found', message: 'Attempt not found on this campaign',
      });
      return null;
    }

    const attempt = await agencyAttemptRepository.findForCampaign(campaign.id, request.params.attemptId);
    if (!attempt) {
      reply.code(404).send({
        error: 'Not Found', code: 'attempt_not_found', message: 'Attempt not found on this campaign',
      });
      return null;
    }

    if (!attempt.webrtc_call_id) return { attempt, call: null, availability: 'never_placed' };

    /*
     * `'agency'` scope. The repository's scope is a required parameter rather
     * than a hardcoded predicate, so every read states the population it means.
     *
     * Tenant/account still bound, so a campaign whose row was somehow reachable
     * cannot be used to read another tenant's call.
     */
    const call = await webrtcCallRepository.findByIdScoped(
      attempt.webrtc_call_id, getTenantId(request), getAccountId(request), 'agency',
    );
    return call
      ? { attempt, call, availability: 'available' }
      : { attempt, call: null, availability: 'purged' };
  }

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId ──────────────────
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId',
    async (request, reply) => {
      if (!(await gate(request, reply))) return reply;
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;

      return reply.send({
        attempt: found.attempt,
        call: found.call
          ? formatWebRtcCallResponse(
              found.call,
              agencyRecordingPath(request.params.id, found.attempt.id),
            )
          : null,
        call_availability: found.availability,
      });
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId/recording ────────
  //
  // Streams the recording through the authenticated proxy, so the raw auth-gated
  // carrier URL is never handed to a client.
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId/recording',
    async (request, reply) => {
      if (!(await gate(request, reply))) return reply;
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;
      if (!found.call) {
        return reply.code(404).send({
          error: 'Not Found',
          code: found.availability === 'purged' ? 'call_purged' : 'call_never_placed',
          message: found.availability === 'purged'
            ? 'The call for this attempt is no longer available'
            : 'No call was placed for this attempt',
        });
      }
      // Dynamic import keeps the config-loading recording-proxy module out of this
      // route module's import graph.
      const { proxyCallRecording } = await import('../../utils/recording-proxy.js');
      // `proxyCallRecording` takes the recording-host allow-list as a parameter
      // (`config.voicelinkRecording.allowedHosts`, from `VOICELINK_RECORDING_HOSTS`).
      // Same dynamic-import posture for the config.
      const { config } = await import('../../config/index.js');
      return proxyCallRecording(found.call, request, reply, config.voicelinkRecording.allowedHosts);
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId/recording-url ────
  //
  // Short-lived signed URL, so the console can put an agency recording straight
  // into an `<audio src>` without forwarding tenant/account headers. It resolves
  // against `/api/v1/webrtc-recordings`, the SHARED playback proxy — that route is
  // deliberately scope-agnostic because the signed token IS the authorization, and
  // this route is the agency-gated minter of it (see the header comment on
  // `webrtc-recordings.routes.ts`).
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId/recording-url',
    async (request, reply) => {
      if (!(await gate(request, reply))) return reply;
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;
      if (!found.call) {
        return reply.code(404).send({
          error: 'Not Found',
          code: found.availability === 'purged' ? 'call_purged' : 'call_never_placed',
          message: found.availability === 'purged'
            ? 'The call for this attempt is no longer available'
            : 'No call was placed for this attempt',
        });
      }
      if (!found.call.recording_url) {
        return reply.code(404).send({
          error: 'Not Found', code: 'no_recording', message: 'No recording available for this call',
        });
      }
      // Direct-recording providers (VoiceLink): signing points playback at the
      // shared proxy, whose egress is firewalled off from the provider's recording
      // host — a 502 where the browser could fetch the file itself. Hand back the
      // raw URL, no expiry (the provider link is the durable resource). The
      // allowlist lives in one place, `isDirectRecordingProvider`.
      if (isDirectRecordingProvider(found.call.provider)) {
        return reply.send({ url: found.call.recording_url, expires_at: null });
      }
      // Dynamic import keeps the config-loading recording-url module out of this
      // route module's import graph.
      const { signRecordingUrl } = await import('../../utils/recording-url.js');
      const signed = signRecordingUrl({
        callId: found.call.id,
        tenantId: getTenantId(request),
        accountId: getAccountId(request),
        basePath: '/api/v1/webrtc-recordings',
      });
      // `.toISOString()` explicitly. Fastify's default serializer JSON.stringify's
      // a Date to the same characters, so the wire shape is the same either way;
      // what differs is the HANDLER's contract, and that is what breaks the moment
      // someone adds a response schema (which would coerce or reject a Date
      // against `type: 'string'`), asserts on the payload, or forwards the object
      // rather than the response.
      //
      // Formatted at the call site rather than in `signRecordingUrl`, which keeps
      // returning `expiresAt: Date`: the instant is the honest return type for a
      // signer.
      return reply.send({ url: signed.path, expires_at: signed.expiresAt.toISOString() });
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/contacts ────────────────────────────
  //
  // The read of what the roster ingest writes.
  app.get<{ Params: { id: string } }>('/:id/contacts', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    const parsed = parseContactFilters((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }
    const cursor = readCursor(request, reply);
    if (cursor === null) return reply;

    const page = await agencyContactRepository.listForCampaign({
      campaignId: campaign.id,
      filters: parsed.filters,
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
    });
    return reply.send(page);
  });

  /**
   * GET /api/v1/agency-campaigns/:id/contacts/:contactId — the drill-down's row.
   *
   * The only read that carries `context`. Scoped by BOTH ids in one predicate:
   * `requireOwned` proves the caller owns the campaign and says nothing about
   * the contact, so a contact id from another campaign — or another tenant —
   * would otherwise resolve through a route the caller is legitimately
   * authorised for.
   *
   * A contact outside this campaign is a 404 with the same body as one that does
   * not exist, so the route cannot be used to test whether an id is real.
   */
  app.get<{ Params: { id: string; contactId: string } }>('/:id/contacts/:contactId', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    // Checked before the query: `findDetailScoped` casts to `uuid`, and a
    // non-UUID id would reach Postgres as `22P02` and surface as a 500 — a bad
    // request that looks like a broken service.
    if (!UUID_PARAM_RE.test(request.params.contactId)) {
      return reply.code(404).send({
        error: 'Not Found', code: 'contact_not_found', message: 'Contact not found',
      });
    }

    const contact = await agencyContactRepository.findDetailScoped(campaign.id, request.params.contactId);
    if (!contact) {
      return reply.code(404).send({
        error: 'Not Found', code: 'contact_not_found', message: 'Contact not found',
      });
    }
    return reply.send(contact);
  });

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
  app.get<{ Params: { id: string } }>('/:id/retry/preview', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    // The PARENT's catalog, which is the vocabulary the seeding predicate will run
    // against — a code the parent's agents used but the child's catalog will not
    // have is still a legitimate thing to select on.
    const parsed = parseRetrySelector(
      (request.query ?? {}) as Record<string, unknown>,
      { catalog: campaign.disposition_catalog ?? [] },
    );
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
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
  app.post<{ Params: { id: string } }>('/:id/retry', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const parent = await requireOwned(request, reply);
    if (!parent) return reply;

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
      return reply.code(400).send({
        error: 'Validation failed',
        details: { idempotency_key: idempotency.message },
      });
    }

    const rawSelector = body['selector'];
    if (rawSelector !== undefined
      && (rawSelector === null || typeof rawSelector !== 'object' || Array.isArray(rawSelector))) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: { selector: 'must be an object of retry selector dimensions' },
      });
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
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }

    // ── Config: inherit from the parent, then patch ─────────────────────────
    const rawOverrides = body['config_overrides'];
    if (rawOverrides !== undefined
      && (rawOverrides === null || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides))) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: { config_overrides: 'must be an object of campaign config fields' },
      });
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
      return reply.code(400).send({
        error: 'Validation failed',
        details: Object.fromEntries(unknownKeys.map((key) => [
          key,
          `${key} is not a campaign config field — a retry inherits everything else from its parent, and its name is set with \`name\``,
        ])),
      });
    }

    if ('caller_ids' in overrides) {
      const issue = callerIdsIssue(overrides['caller_ids']);
      if (issue) {
        return reply.code(400).send({ error: 'Validation failed', details: { caller_ids: issue } });
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
  app.get<{ Params: { id: string } }>('/:id/lineage', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

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

  // ── Lifecycle ────────────────────────────────────────────────────────────
  //
  // `start`/`resume`/`pause` are supervisor-owned. `stop` sets `stopping` and the
  // PACING LEADER finalizes to `stopped` once in-flight attempts drain — the
  // leader is the only writer of `running → completed` and `stopping → stopped`,
  // so there is exactly one writer and no race with these controls.

  /**
   * Refuse to start a campaign that has nothing to dial.
   *
   * Without this, `POST /:id/start` on an empty campaign succeeds and answers
   * `running`. What follows is not a stuck campaign — it is worse to diagnose than
   * that: the pacing leader picks the campaign up within one supervise pass, finds
   * `countOutstanding = 0` and finalizes it straight to `completed`. So the operator
   * gets a 200 saying Running, and a dashboard that says Completed a couple of
   * seconds later, having placed no calls and having said nothing about why. The
   * roster upload they forgot is never mentioned.
   *
   * Checked at the route rather than in the engine because this is the only moment
   * a human is present to be told. Returns false only when it has already replied.
   */
  async function rosterRejected(reply: FastifyReply, campaign: AgencyCampaignRecord): Promise<boolean> {
    const roster = await agencyCampaignRepository.rosterCounts(campaign.id);
    if (roster.dialable > 0) return false;
    // The two cases are distinguished because the remedy differs — see
    // `rosterCounts`. Cheap: it is the same single query either way.
    reply.code(409).send(roster.total === 0
      ? {
        error: 'No Contacts',
        code: 'campaign_roster_empty',
        message: 'This campaign has no contacts. Upload a contact roster before starting it.',
      }
      : {
        error: 'No Contacts',
        code: 'campaign_roster_exhausted',
        message: `All ${roster.total} contacts on this campaign have been completed, exhausted or suppressed. Upload a fresh roster before starting it again.`,
      });
    return true;
  }

  /**
   * Who pressed the control, from the optional transition body.
   *
   * ── Optional, and `/stop` is the reason ────────────────────────────────────
   *
   * `checkActor` 400s an attempt-scoped write with no actor, because a disposition
   * IS the record of who said what about a customer. A lifecycle transition is not
   * that: the transition is the fact and the actor is attribution ON it. Refusing
   * the transition for want of attribution would put a 400 in front of **the off
   * button** for any caller that does not send one — the same class of
   * mistake as gating `/stop` behind the dialer flag (see `gate`). So an absent,
   * blank or wrong-typed `actor_user_id` yields `null` and the campaign records an
   * unattributed transition.
   *
   * ⚠️ `null` therefore has two causes — genuinely automatic (the guardrail's
   * auto-pause, the leader's finalization) and "the caller did not say" — and the
   * payload cannot separate them. Accepted: see
   * {@link AgencyCampaignTransitionRequest}. The one thing that must not happen is
   * a fabricated actor, so an id-less body is `null` rather than the originator
   * header, which is an origination LABEL (a client hint) and not a user id.
   *
   * ── The NAME is truncated; the ID is DROPPED. The asymmetry is the point ───
   *
   * Both columns can raise `22001 value too long`, which on this path would fail
   * the TRANSITION — a supervisor losing a control because a string was long — so
   * neither over-long value may reach Postgres. What differs is what to do with it:
   *
   *   * `actor_name` is TRUNCATED. It exists to be read, so losing its tail is a
   *     cosmetic loss and the rest of the name still identifies the person.
   *   * `actor_user_id` is DROPPED — the actor becomes `null`. An id is an
   *     IDENTITY: it resolves back to a user, so a truncated one is not a
   *     shortened answer, it is a DIFFERENT (or nonexistent) user. Storing it would
   *     attribute the transition to the wrong human, which is the one failure the
   *     `null`-means-unknown contract exists to prevent. Better to record that we do
   *     not know who than to record somebody else.
   *
   * Unreachable in practice (user ids are UUIDs, well inside 100), so the
   * warn is the only symptom — which is why there is one: a silent drop on a field
   * whose whole job is attribution would look like a caller that simply did not
   * send it.
   */
  function readTransitionActor(body: unknown): AgencyCampaignActor | null {
    const raw = (body ?? {}) as { actor_user_id?: unknown; actor_name?: unknown };
    const userId = typeof raw.actor_user_id === 'string' ? raw.actor_user_id.trim() : '';
    if (!userId) return null;
    if (userId.length > ACTOR_USER_ID_MAX) {
      // Length only — never the value. An actor id is a user identifier, and
      // logs have no business holding one.
      log.warn(
        { length: userId.length, max: ACTOR_USER_ID_MAX },
        'Campaign transition actor id exceeds the column width — recording the transition unattributed',
      );
      return null;
    }
    const name = typeof raw.actor_name === 'string' ? raw.actor_name.trim() : '';
    return { user_id: userId, name: name ? name.slice(0, ACTOR_NAME_MAX) : null };
  }

  async function transition(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    from: readonly string[],
    to: string,
    patch: { last_transition_by?: AgencyCampaignActor | null } = {},
    opts: { requireRoster?: boolean; ungated?: boolean } = {},
  ) {
    if (!opts.ungated && !(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request, reply);
    if (!campaign) return reply;

    if (!from.includes(campaign.status)) {
      return reply.code(409).send({
        error: 'Invalid Transition',
        code: 'invalid_campaign_transition',
        message: `A campaign in '${campaign.status}' cannot move to '${to}'.`,
        current_status: campaign.status,
      });
    }

    // After the transition guard, so a campaign in the wrong status still gets the
    // transition error rather than a roster error it cannot act on yet.
    if (opts.requireRoster && await rosterRejected(reply, campaign)) return reply;

    try {
      const updated = await agencyCampaignRepository.transitionStatus(campaign.id, from, to, patch);
      if (!updated) {
        // The guard matched on read but not on write — something moved underneath
        // us (most likely the pacing leader finalizing). Re-read and report.
        const fresh = await agencyCampaignRepository.findById(campaign.id);
        return reply.code(409).send({
          error: 'Invalid Transition',
          code: 'invalid_campaign_transition',
          message: 'The campaign changed state before this could be applied.',
          current_status: fresh?.status ?? null,
        });
      }
      auditLogger.log({
        tenantId: campaign.tenant_id, accountId: campaign.account_id,
        eventType: `agency_campaign.${to}`, eventCategory: 'call', severity: 'info',
        actor: getOriginator(request) ?? 'system:api',
        eventData: { campaign_id: campaign.id, from: campaign.status, to },
      });
      return reply.send(formatAgencyCampaignResponse(updated));
    } catch (err) {
      // 23505 here is uq_agency_campaign_running: ONE running campaign is permitted
      // per account in v1. Surface it as something the console can explain — a raw
      // unique violation would reach a supervisor as an opaque 500.
      if ((err as { code?: string }).code === '23505') {
        log.info({ campaignId: campaign.id }, 'Refused start — another campaign is already running');
        return reply.code(409).send({
          error: 'Already Running',
          code: 'another_campaign_running',
          message: 'Another campaign is already running for this account. Pause or stop it first.',
        });
      }
      throw err;
    }
  }

  // ── `started_at` is not passed from here, deliberately ─────────────────────
  //
  // The lifecycle stamps are derived from the TARGET STATUS inside the single
  // UPDATE that moves a status, which is why there is nothing to
  // pass. A route that passed `{ started_at: new Date() }` on `/resume` would
  // overwrite the original start, so a campaign that began at 09:00 and resumed
  // after lunch would report 14:05; with no parameter, a fifth route cannot
  // reintroduce that by forgetting one.
  //
  // What IS passed is the actor, and only when the caller supplied one.
  // Deliberately spread rather than always present, so a body-less call (a
  // `curl`, say) produces an empty `{}` patch.
  const actorPatch = (req: FastifyRequest): { last_transition_by?: AgencyCampaignActor } => {
    const actor = readTransitionActor(req.body);
    return actor ? { last_transition_by: actor } : {};
  };

  app.post<{ Params: { id: string } }>('/:id/start', (req, reply) =>
    transition(req, reply, ['draft', 'paused'], 'running', actorPatch(req),
      { requireRoster: true }));

  app.post<{ Params: { id: string } }>('/:id/pause', (req, reply) =>
    // In-flight attempts are never cancelled by a pause — they complete normally.
    // Ungated: see `gate`. Pausing can only reduce dialing.
    transition(req, reply, ['running'], 'paused', actorPatch(req), { ungated: true }));

  // Deliberately NOT roster-gated, unlike `/start`. A resume follows a pause the
  // supervisor themselves issued moments ago, and a campaign that drained while
  // paused is finalized by the leader on its first tick — refusing here would put a
  // 409 in front of a control whose only remaining job is to let that happen.
  app.post<{ Params: { id: string } }>('/:id/resume', (req, reply) =>
    transition(req, reply, ['paused'], 'running', actorPatch(req)));

  app.post<{ Params: { id: string } }>('/:id/stop', (req, reply) =>
    // 200 means "accepted and draining", NOT "stopped". The leader finalizes to
    // `stopped` on its next idle tick; clients must not assert terminal state
    // from this response.
    //
    // **Ungated — this is the off button** (see `gate`).
    //
    // **`draft` is deliberately NOT a source**, and not because stopping would
    // brick it. `stopping` is left only by `maybeFinalize`, and if the drain were
    // measured in roster rows every status would be condemned alike (a campaign
    // stopped at row 100 of 50 000 leaves 49 900 `pending` rows behind, which
    // nothing clears), as would every status with the dialer flag off and no
    // leader to run `maybeFinalize`. `PacingEngine` handles both — a `stopping`
    // campaign is led whatever the flag says, and its drain is measured in live
    // attempts rather than roster rows — so every source status here reaches
    // `stopped` unaided.
    //
    // `draft` stays refused because a draft has nothing to stop: the operator wants
    // delete, or to leave it alone. They get the ordinary
    // `invalid_campaign_transition` 409 naming `draft`, which is readable, whereas a
    // 200 for a campaign that was never dialing is not.
    transition(req, reply, ['running', 'paused'], 'stopping', actorPatch(req), { ungated: true }));
}
