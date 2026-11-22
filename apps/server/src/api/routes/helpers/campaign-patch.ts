/*
 * The campaign settings PATCH of the public API layer, as one function that answers rather than
 * replies: `PATCH /proxy/agency/campaigns/:id` sends what it answers, and a campaign template's
 * apply (CT16, `proxy-agency-campaign-templates/apply.ts`) runs the very same path for each draft
 * campaign it writes, its checks and its audit included, and reads the answer per campaign. One
 * definition, so an apply can never write what the PATCH would refuse, nor skip its audit row.
 *
 * A campaign made from a template has its `template_source` recomputed by this path too (CT9 as
 * amended): the internal handler's write does it in the same transaction as the settings
 * (`writeCampaignPatch`), so the record and the settings cannot disagree.
 */
import type { FastifyRequest } from 'fastify';
import { callCore } from '../../core-dispatch.js';
import { ACCOUNT_HEADER, CONFIG_CHANGE_HEADER } from '../../middleware/headers.js';
import { behavioralCapabilityRefusal } from '../../../agency/campaign-behavioral-settings.js';
import { assignmentSettingsRefusal } from '../../../agency/campaign-assignment-gate.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { decodeConfigChange } from '../../../agency/campaign-config-audit.js';
import { validateAgencyCampaignConfig, issuesToDetails } from '../../../agency/agency-campaign-config.js';
import { ownedCoreCampaignOnce, stringField } from './core-campaign.js';

/** What the PATCH path answered: the status and body the route sends. */
export interface CampaignPatchAnswer {
  status: number;
  body: unknown;
}

/** The internal handler's `authMiddleware` 400 for a request with no account. */
export function missingAccountBody(): { error: string; message: string } {
  return { error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` };
}

/**
 * Patch campaign `campaignId` of the request's tenant and account with `patchBody`, as
 * `PATCH /proxy/agency/campaigns/:id` does, and say what to answer. Audits on success (the mode
 * change and the config change, IN8) as the actor of `request`.
 *
 * ── Validation ──────────────────────────────────────────────────────────────
 * Same validation on the patch surface as on create, and it has to be: the builder edits a
 * running campaign's window and catalog here, so validating only on create would leave every
 * rule reachable one PATCH later.
 *
 * Cross-field rules see only what THIS body carries — a patch sending `calling_window_start`
 * alone cannot be checked against a stored `end` this layer does not hold. That is the cost of
 * not keeping a copy, and it is the right trade: the alternative is a second writable campaign
 * here.
 *
 * ── Editing a RUNNING campaign — the documented rule ─────────────────────────
 * **Allowed, and this layer adds no campaign-status gate.** Pausing to change a calling window
 * is the opposite of what a compliance edit needs: the window is most often wrong *while* the
 * campaign is dialing outside it, and forcing a pause there means either dialing on for the
 * length of the round trip or stopping a compliant campaign to fix a non-compliant one. (A
 * template apply, CT16, is the exception and checks the status itself: it writes drafts only.)
 *
 * This layer could not enforce such a gate honestly in any case — it holds no campaign copy, so
 * it would have to GET the campaign first and act on a status that can change between the two
 * calls. The internal handler is where a status rule belongs, and it deliberately has none on
 * PATCH (only `status` itself is unpatchable, so lifecycle stays with /start, /pause, /resume,
 * /stop and a config edit can never race the pacing leader's own writes) — with ONE exception,
 * `assignment_mode`, which changes only while draft or paused (decision CA10; see below and
 * `assignmentModeChangeRefused`).
 *
 * **When the edit takes effect, stated precisely — "applies to future attempts only" is close
 * but not exact.** The pacing loop re-reads the campaign every tick (`findActive()` /
 * `findById()`, no cache), so:
 *  - a contact NOT yet dialed is planned against the new config from the next tick — the
 *    ordinary case;
 *  - an attempt ALREADY dispatched carries the campaign snapshot taken when it was dialed
 *    (`cmd.campaign`), so its own retry decision uses the OLD policy;
 *  - EXCEPT down the reaper's path, which joins `c.retry_policy` live (`findLapsedWrapups` in
 *    `agency/attempt.repository.ts`) and therefore resolves against the NEW policy for an
 *    attempt dialed before the edit.
 * So "future attempts only" holds for the dial path and not for the reaper. Nothing in flight is
 * retro-actively re-planned either way, which is the property that makes editing a live campaign
 * safe to offer.
 *
 * ── The behavioral capabilities ─────────────────────────────────────────────
 * Checked here as well as on create for the same reason the config validation is: a rule
 * enforced only on POST is a rule one PATCH away from being bypassed. A campaign created with
 * recording off can otherwise be patched to `record_calls: true` by an account that never had
 * the capability.
 *
 * The forwarded body is bound ONCE and that same object is both asserted and forwarded. The
 * target is the request's tenant and account, and it cannot differ from the campaign's owner:
 * the internal PATCH handler runs `requireOwned`, which answers 404 unless the campaign's
 * `tenant_id` AND `account_id` equal the `x-mgkvc-tenant` / `x-mgkvc-account` headers `callCore`
 * sets from these same two values. So a body asserted against account Y's settings can only ever
 * write a campaign that account Y owns; reading the row first to learn its account would be a
 * second read that can only agree. A body that enables a capability this account lacks is
 * refused and nothing is forwarded (`proxy-agency-campaign-behavioral-capabilities.routes.test.ts`,
 * the PATCH twin cases).
 */
export async function patchCampaignConfig(
  request: FastifyRequest,
  campaignId: string,
  patchBody: unknown,
): Promise<CampaignPatchAnswer> {
  const configIssues = validateAgencyCampaignConfig(patchBody);
  if (configIssues.length > 0) {
    return { status: 400, body: { error: 'Validation Error', details: issuesToDetails(configIssues) } };
  }

  // No account context: answered as the internal handler's `authMiddleware` 400 for a
  // missing `x-mgkvc-account`, before the settings read (which has no row to judge).
  if (!request.accountId) return { status: 400, body: missingAccountBody() };
  const refusal = await behavioralCapabilityRefusal(patchBody, {
    tenantId: request.tenantId,
    accountId: request.accountId,
  });
  if (refusal) return { status: 403, body: refusal };
  // Contact assignment (CA9), on the same object, for the same reason as above.
  // The stored campaign, read at most once and only when asked: the assignment gate judges
  // the body against it, and an `assignment_mode` change is audited with its `from`.
  const stored = ownedCoreCampaignOnce(request, campaignId);
  // What the campaign already holds asks for nothing (a save after the flag was turned off).
  const assignment = await assignmentSettingsRefusal(patchBody, {
    tenantId: request.tenantId!,
    accountId: request.accountId,
  }, stored.stored);
  if (assignment) return assignment;

  // ── `assignment_mode`: the status rule is the handler's, the audit row is ours ──
  //
  // The internal handler refuses a mode CHANGE outside draft/paused (409
  // `mode_change_requires_pause`), forwarded unchanged below, so this layer still
  // adds no status gate of its own. A real change is audited here, and only on
  // success: `agency_campaign.assignment_mode_changed` with `{ from, to }`. `from` is
  // read first, through the ownership probe, only when the body names a mode; sending
  // the stored mode again is not a change and files nothing. Two PATCHes racing a mode
  // change could each read the same `from`; the row then names the earlier value, and
  // the handler's status rule, not this read, is what decides whether a change lands.
  const namesMode = patchBody !== null && typeof patchBody === 'object'
    && Object.hasOwn(patchBody, 'assignment_mode');
  let modeBefore: string | null = null;
  if (namesMode) {
    const current = await stored.probe();
    if (!current.ok) return { status: current.status, body: current.body };
    modeBefore = stringField(current.body, 'assignment_mode');
  }

  const result = await callCore({
    // PATCH, and the body must travel with it: a PATCH sent with NO body is a
    // write that does nothing and still reads as a success.
    method: 'PATCH',
    path: `/agency-campaigns/${campaignId}`,
    body: patchBody,
    tenantId: request.tenantId!,
    accountId: request.accountId,
  });

  const modeAfter = result.status < 400 ? stringField(result.body, 'assignment_mode') : null;
  if (namesMode && modeBefore && modeAfter && modeAfter !== modeBefore) {
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'agency_campaign.assignment_mode_changed',
      resource_type: 'agency_campaign',
      resource_id: campaignId,
      campaign_id: campaignId,
      details: { campaign_id: campaignId, from: modeBefore, to: modeAfter },
    });
  }

  // ── Every config change is audited too (IN8) ──────────────────────────────
  // One row per successful PATCH that changed anything, naming each changed field
  // with `{ from, to }` for the small ones. The handler computed the change (it holds
  // the row before and after the write) and sent it on a private response header,
  // so this costs no read here: a PATCH stays one internal call. Absent header = no
  // change (a save of what is stored) = no row. Kept beside the mode row above, not
  // instead of it: `assignment_mode_changed` is the CA10 trail's own action.
  // `?.`: a double of `callCore` may answer without headers, and an audit read must
  // never fail a write that has already landed.
  const change = result.status < 400
    ? decodeConfigChange(result.headers?.get(CONFIG_CHANGE_HEADER))
    : null;
  if (change) {
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'agency_campaign.config_changed',
      resource_type: 'agency_campaign',
      resource_id: campaignId,
      campaign_id: campaignId,
      details: { campaign_id: campaignId, fields: change.fields, changes: change.changes },
    });
  }
  return { status: result.status, body: result.body };
}
