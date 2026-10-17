/*
 * The campaign ownership proof the activity trail and the spine exports run before any
 * read: the internal handler's `GET /agency-campaigns/:id` (its gate and `requireOwned`),
 * forwarded unchanged on refusal. Part of `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { fetchOwnedCoreCampaign, stringField } from '../helpers/core-campaign.js';

/**
 * The ownership probe's outcome. The internal handler REFUSING is forwarded as-is and
 * returns `null` instead.
 *
 * There is no "could not ask" outcome: the probe runs the internal handler in-process
 * (`callCore`), which answers or throws. `accountId` is the campaign row's own account,
 * which `ActivityQuery.accountId` takes.
 */
export type OwnedCampaign = { accountId: string; name: string | null };

/**
 * Resolve the campaign and prove the caller owns it, BEFORE either audit read.
 *
 * This is the whole of the authorisation for the activity trail's routes.
 * `requirePermission` proves the caller's ROLE and never looks at the target
 * row (the rule stated at the top of `rbac/`), so without this a supervisor
 * could pass another tenant's campaign id and enumerate its audit rows — the
 * exact shape of the cross-tenant defects two reviews already found.
 *
 * The check is the internal handler's campaign read, because this layer keeps
 * no campaign copy (see the ownership-split comment at the top of `proxy-agency-campaigns.routes.ts`).
 * The handler's `requireOwned` answers 404 for a campaign in another tenant or
 * account, and that status is forwarded unchanged — a cross-tenant id and a
 * nonexistent one must stay indistinguishable, or the response is a
 * campaign-id oracle.
 *
 * It also returns the account stamped on the campaign row, which is what the
 * dialer runtime's `audit_logs` rows carry.
 *
 * The probe is `GET /agency-campaigns/:id` through `callCore`, rather than
 * `agencyCampaignRepository.findById` plus a copy of `requireOwned`'s rule
 * here, because the handler already applies the whole rule: its `gate` (the
 * `agency_dialer_enabled` flag, so a flag-off account is refused here too) and
 * its `requireOwned` (tenant AND account), answering its own 404 body. A second
 * copy of that rule in this layer would be a second thing to keep in step. The
 * account it returns is the formatted row's `account_id`
 * (`formatAgencyCampaignResponse` spreads the row), read AFTER the ownership
 * proof — the value `ActivityQuery.accountId` requires.
 *
 * Failure posture:
 *  - `callCore` throws only when the handler table was never built (a wiring
 *    defect), so there is no outage to degrade around: a throw propagates as a
 *    500;
 *  - no timeout: `callCore` installs no signal, and there is no degraded path a
 *    timeout could fall back to;
 *  - no fallback for a missing `account_id`: the column is a NOT NULL `uuid`,
 *    and a probe that reached 200 passed `requireOwned`, which matched it. A
 *    body without it is a defect, refused rather than guessed (a guess would be
 *    a `22P02` or the wrong account's trail).
 */
export const requireOwnedCampaign = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<OwnedCampaign | null> => {
  const probe = await fetchOwnedCoreCampaign(request, request.params.id);
  if (!probe.ok) {
    // A REFUSAL is the handler's answer and is forwarded unchanged — a cross-tenant id
    // and a nonexistent one must stay indistinguishable.
    await reply.code(probe.status).send(probe.body);
    return null;
  }
  const accountId = stringField(probe.body, 'account_id');
  if (!accountId) {
    throw new Error('agency campaign ownership probe: the internal handler answered without the campaign\'s account_id');
  }
  return {
    accountId,
    name: stringField(probe.body, 'name'),
  };
};
