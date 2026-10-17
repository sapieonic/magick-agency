/*
 * The internal campaign routes' shared guards: the dialer feature `gate`, `requireOwned`
 * and the route-level `ownedCampaign` preHandler, and the config refusals the create, the
 * PATCH and the retry create share. Part of `agency-campaigns.routes.ts`.
 */
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import { announcementRepository } from '@magick-agency/db/repositories/announcement.repository';
import { preflightAnalysisProfile } from '../../../analysis/profile-preflight.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { issuesToDetails, validateAgencyCampaignConfig } from '../../../agency/campaign-config.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';

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
export async function gate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
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
export function callerIdsIssue(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'at least one caller ID is required';
  // `.trim()` because a whitespace-only entry is the same defect as an empty one
  // and arrives from the same place — a text input or a CSV cell.
  if (!value.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    return 'every caller ID must be a non-empty string';
  }
  return null;
}

export async function requireOwned(
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
 * The campaign a route acts on, proved once per request by its `ownedCampaign`
 * preHandler and read by the handler with {@link campaignOf}.
 */
const ownedCampaigns = new WeakMap<FastifyRequest, AgencyCampaignRecord>();

/**
 * The route-level preHandler every `/:id…` route here carries: the feature `gate`
 * (unless `gated: false` — `/stop` and `/pause` only, see `gate`), then
 * `requireOwned`, in that order, each answering its own refusal. Runs after this
 * plugin's `authMiddleware`, exactly where the two calls used to open each handler.
 */
export function ownedCampaign(opts: { gated: boolean }): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (opts.gated && !(await gate(request, reply))) return reply;
    const campaign = await requireOwned(request as FastifyRequest<{ Params: { id: string } }>, reply);
    if (!campaign) return reply;
    ownedCampaigns.set(request, campaign);
    return undefined;
  };
}

/** The campaign {@link ownedCampaign} proved for this request; a throw is a wiring defect. */
export function campaignOf(request: FastifyRequest): AgencyCampaignRecord {
  const campaign = ownedCampaigns.get(request);
  if (!campaign) throw new Error('agency campaign route registered without its ownedCampaign preHandler');
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
export function configRejected(
  reply: FastifyReply,
  body: unknown,
  base: { calling_window_start?: string; calling_window_end?: string },
): boolean {
  const issues = validateAgencyCampaignConfig(body, base);
  if (issues.length === 0) return false;
  replyValidationFailed(reply, issuesToDetails(issues));
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
export async function abandonAnnouncementRejected(
  request: FastifyRequest,
  reply: FastifyReply,
  value: unknown,
): Promise<boolean> {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' || value.trim() === '') {
    replyValidationFailed(reply, { abandon_announcement_id: 'must be an announcement id, or null to clear it' });
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
export async function analysisProfileRejected(
  request: FastifyRequest,
  reply: FastifyReply,
  value: unknown,
): Promise<boolean> {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' || value.trim() === '') {
    replyValidationFailed(reply, { analysis_profile_id: 'must be a call-analysis profile id, or null to clear it' });
    return true;
  }
  const err = await preflightAnalysisProfile(value, getTenantId(request), getAccountId(request), 'agency');
  if (err) {
    reply.code(err.status).send({ error: err.error, code: err.code, message: err.message });
    return true;
  }
  return false;
}
