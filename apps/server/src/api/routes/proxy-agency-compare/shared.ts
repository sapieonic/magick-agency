/*
 * What the Compare agents routes share: their dependencies (injectable for tests), the guards (RBAC
 * then the flag), the refusal body, the campaign probe and the saved view's wire shape. Part of
 * `proxy-agency-compare.routes.ts`.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  AGENCY_COMPARE_ERROR_STATUS,
  COMPARE_BUSY_RETRY_AFTER_SECONDS,
  type AgencyCompareErrorCode,
  type AgencyCompareOutcomeCode,
  type AgencyCompareView,
} from '@magick-agency/contracts/api/agency/compare';
import { compareOutcomeCodes } from '@magick-agency/domain/agent-compare';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import {
  agencyCampaignRepository,
  agencyCompareViewRepository,
  type AgencyCompareViewRepository,
  type CompareViewRecord,
} from '../../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { CompareReads } from '../../../agency/compare/read.js';
import { COMPARE_ERROR_MESSAGES, uuidOf } from '../../../agency/compare/validate.js';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { effectiveCatalog } from '../../../agency/disposition-policy.js';
import { localDateOf } from '../../../agency/reports/schedule.js';
import { postgresZoneName } from '../../../agency/zone.js';
import { sendRefusal } from '../helpers/refusal.js';

/** The flag gate's refusal: the dialer gate's body shape (`helpers/dialer-gate.ts`), for this page. */
export const COMPARE_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Compare agents is not enabled for this account.',
} as const;

/** A campaign of the context account, as the compare routes read it. */
export interface CompareCampaign {
  id: string;
  name: string;
  /** Its CURRENT outcome catalog (the default when it stores none), in catalog order. */
  codes: AgencyCompareOutcomeCode[];
}

/** Everything the compare routes read or write, injectable for tests. */
export interface CompareRouteDeps {
  reads: CompareReads;
  views: Pick<AgencyCompareViewRepository, 'list' | 'findOwned' | 'findCampaignDefault' | 'create' | 'update' | 'delete'>;
  /** `agency_compare_enabled` for the request's tenant and account. A throw propagates (fails closed). */
  compareEnabled(request: FastifyRequest): Promise<boolean>;
  /** The campaign if it is the tenant's AND the account's, else null. `campaignId` is a lower-cased UUID. */
  campaign(tenantId: string, accountId: string, campaignId: string): Promise<CompareCampaign | null>;
  names(userIds: readonly string[], tenantId: string): Promise<Map<string, string | null>>;
  /**
   * The name Postgres cuts the zone's days in (`postgresZoneName`: its own spelling, or a legacy
   * name's current one), or null when it knows neither.
   */
  databaseZone(zone: string): Promise<string | null>;
  /** Today's local date in `zone`. */
  today(zone: string): string;
}

/** The production dependencies; `reads` is one per registration (closed with the app). */
export function defaultCompareRouteDeps(): CompareRouteDeps {
  return {
    reads: new CompareReads(),
    views: agencyCompareViewRepository,
    compareEnabled: (request) => getFeatureFlagService().isEnabled(FLAGS.agency_compare_enabled, {
      tenantId: request.tenantId!,
      ...(request.accountId ? { accountId: request.accountId } : {}),
    }),
    async campaign(tenantId, accountId, campaignId) {
      const row = await agencyCampaignRepository.findById(campaignId);
      if (!row || row.tenant_id !== tenantId || row.account_id !== accountId) return null;
      return { id: row.id, name: row.name, codes: compareOutcomeCodes(effectiveCatalog(row.disposition_catalog)) };
    },
    names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'compare views'),
    databaseZone: postgresZoneName,
    today: (zone) => localDateOf(new Date(), zone),
  };
}

/**
 * `{ error, code, message }` with the code's status (`AGENCY_COMPARE_ERROR_STATUS`), through
 * `sendRefusal`. `compare_busy` also carries when to try again, as the error mask's policy asks of an
 * authored 429 (`COMPARE_BUSY_RETRY_AFTER_SECONDS`). `compare_timed_out` (503) is a fixed, reviewed
 * body, sent through the error mask's reviewed opt-out (`preserveReviewedUpstreamError`) so it is not
 * masked as "contact support" (the contract's rule).
 */
export function sendCompareRefusal(reply: FastifyReply, code: AgencyCompareErrorCode, message?: string): FastifyReply {
  const status = AGENCY_COMPARE_ERROR_STATUS[code];
  if (status >= 500) reply.request.preserveReviewedUpstreamError = true;
  return sendRefusal<AgencyCompareErrorCode>(
    reply, status, code, message ?? COMPARE_ERROR_MESSAGES[code],
    code === 'compare_busy' ? { retryAfterSeconds: COMPARE_BUSY_RETRY_AFTER_SECONDS } : {},
  );
}

/** The campaign (`compare_campaign_required`, `compare_campaign_not_found`). Null once it has replied. */
export async function resolveCompareCampaign(
  deps: CompareRouteDeps,
  reply: FastifyReply,
  q: { tenantId: string; accountId: string; campaignId: unknown },
): Promise<CompareCampaign | null> {
  if (q.campaignId === undefined || q.campaignId === null || q.campaignId === '') {
    sendCompareRefusal(reply, 'compare_campaign_required');
    return null;
  }
  const campaignId = uuidOf(q.campaignId);
  const campaign = campaignId === null ? null : await deps.campaign(q.tenantId, q.accountId, campaignId);
  if (campaign === null) {
    sendCompareRefusal(reply, 'compare_campaign_not_found');
    return null;
  }
  return campaign;
}

/**
 * A signal that aborts when the client goes away before its answer: the response's connection
 * closes while the response is unfinished (a browser that aborts a superseded fetch, a closed tab).
 * The compare read then gives the tenant's slot back and cancels its statement
 * (`agency/compare/read.ts`). A response that finishes also closes; that one aborts nothing.
 */
export function clientGoneSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  // Gone already (the connection closed while the hooks ran): 'close' has fired and will not again.
  // The response and the socket only: a request whose body has been read is destroyed in current
  // Node (auto-destroy after 'end') with its client still waiting.
  const socket = reply.raw.socket ?? reply.request.raw.socket;
  if (reply.raw.destroyed || socket?.destroyed === true) {
    controller.abort();
    return controller.signal;
  }
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** The status of an answer nobody waits for any more (the client closed the request first). */
export const CLIENT_CLOSED_STATUS = 499;

/**
 * The route-level guard every compare route runs after `requirePermission('agency.supervise')` (RBAC,
 * then the flag): the flag, else `403 feature_disabled` before any body is read.
 */
export function compareGuards(deps: CompareRouteDeps): { preHandler: preHandlerAsyncHookHandler[] } {
  const compareGate: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!(await deps.compareEnabled(request))) return reply.code(403).send(COMPARE_DISABLED_BODY);
  };
  return { preHandler: [requirePermission('agency.supervise'), compareGate] };
}

/** A stored view on the wire, its owner named. */
export function compareViewToWire(row: CompareViewRecord, names: ReadonlyMap<string, string | null>): AgencyCompareView {
  return {
    id: row.id,
    name: row.name,
    lens: row.lens,
    metrics: row.metrics,
    trend: row.trend,
    campaign_id: row.campaign_id,
    shared: row.shared,
    is_campaign_default: row.is_campaign_default,
    owner: { user_id: row.owner_user_id, name: names.get(row.owner_user_id) ?? null },
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
