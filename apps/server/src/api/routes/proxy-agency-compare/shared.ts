/*
 * What the Compare agents routes share: their dependencies (injectable for tests), the flag gate,
 * the refusal body, the campaign probe and the saved view's wire shape. Part of
 * `proxy-agency-compare.routes.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_COMPARE_ERROR_STATUS,
  COMPARE_BUSY_RETRY_AFTER_SECONDS,
  type AgencyCompareErrorCode,
  type AgencyCompareErrorResponse,
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
import { COMPARE_ERROR_MESSAGES } from '../../../agency/compare/validate.js';
import { effectiveCatalog } from '../../../agency/my-day.js';
import { localDateOf } from '../../../agency/reports/schedule.js';
import { postgresZoneName } from '../../../agency/reports/zone.js';
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
  views: Pick<AgencyCompareViewRepository, 'list' | 'findVisible' | 'findOwned' | 'findCampaignDefault' | 'create' | 'update' | 'delete'>;
  /** `agency_compare_enabled` for the request's tenant and account. A throw propagates (fails closed). */
  compareEnabled(request: FastifyRequest): Promise<boolean>;
  /** The campaign if it is the tenant's AND the account's, else null. `campaignId` is a lower-cased UUID. */
  campaign(tenantId: string, accountId: string, campaignId: string): Promise<CompareCampaign | null>;
  names(userIds: readonly string[], tenantId: string): Promise<Map<string, string | null>>;
  /** Is the zone in Postgres's zone database (the reads cut days with `AT TIME ZONE`)? */
  /**
   * The name Postgres cuts the zone's days in (`postgresZoneName`: its own spelling, or a legacy
   * name's current one), or null when it knows neither.
   */
  databaseZone(zone: string): Promise<string | null>;
  /** Today's local date in `zone`. */
  today(zone: string): string;
  now(): Date;
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
    now: () => new Date(),
  };
}

/**
 * `{ error, code, message }` with the code's status (`AGENCY_COMPARE_ERROR_STATUS`). `compare_busy`
 * also carries when to try again, as the error mask's policy asks of an authored 429: the
 * `Retry-After` header and `retry_after_seconds` (`COMPARE_BUSY_RETRY_AFTER_SECONDS`).
 */
export function sendCompareRefusal(reply: FastifyReply, code: AgencyCompareErrorCode, message?: string): FastifyReply {
  if (code === 'compare_busy') {
    const body: AgencyCompareErrorResponse = {
      error: 'Too Many Requests',
      code,
      message: message ?? COMPARE_ERROR_MESSAGES[code],
      retry_after_seconds: COMPARE_BUSY_RETRY_AFTER_SECONDS,
    };
    return reply
      .code(AGENCY_COMPARE_ERROR_STATUS[code])
      .header('Retry-After', String(COMPARE_BUSY_RETRY_AFTER_SECONDS))
      .send(body);
  }
  return sendRefusal<AgencyCompareErrorCode>(
    reply,
    AGENCY_COMPARE_ERROR_STATUS[code],
    code,
    message ?? COMPARE_ERROR_MESSAGES[code],
  );
}

/**
 * `503 compare_timed_out`: a fixed, reviewed body, sent through the error mask's reviewed opt-out
 * (`preserveReviewedUpstreamError`) so it is not masked as "contact support" (the contract's rule).
 */
export function sendCompareTimedOut(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  request.preserveReviewedUpstreamError = true;
  const body: AgencyCompareErrorResponse = {
    error: 'Service Unavailable',
    code: 'compare_timed_out',
    message: COMPARE_ERROR_MESSAGES.compare_timed_out,
  };
  return reply.code(AGENCY_COMPARE_ERROR_STATUS.compare_timed_out).send(body);
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

/** The flag, else `403 feature_disabled`. False once it has replied. */
export async function compareGate(deps: CompareRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await deps.compareEnabled(request)) return true;
  await reply.code(403).send(COMPARE_DISABLED_BODY);
  return false;
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
