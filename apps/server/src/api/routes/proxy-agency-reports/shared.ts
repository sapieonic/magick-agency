/*
 * What the report routes share: their dependencies (injectable for tests), the refusal body, the
 * flag gate, the caller's reach over a subject, and the zone check (`Intl`, then Postgres). Part of
 * `proxy-agency-reports.routes.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type {
  AgencyReportErrorCode,
  ReportAudience,
  ReportKind,
} from '@magick-agency/contracts/api/agency/reports';
import { getPresignedUrl, type PresignOptions } from '../../../storage/s3.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { platformAuditLogger, type PlatformCreateAuditLogInput } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { isUsableTimezone } from '../../../agency/calling-hours.js';
import type { AppConfig } from '../../../config/index.js';
import {
  agencyCampaignRepository,
  reportRunRepository,
  reportSubscriptionRepository,
  type ReportRunRecord,
  type ReportRunRepository,
  type ReportSubscriptionRepository,
} from '../../../db/repositories/agency.repository.js';
import { isMemberOfAccountEver, usersWithPermissionOnAccount } from '../../../agency/reports/access.js';
import { resolveReportNames, type ReportNameRef, type ReportNames } from '../../../agency/reports/run-view.js';
import { postgresKnowsZone } from '../../../agency/reports/zone.js';
import { fetchOwnedCoreCampaign } from '../helpers/core-campaign.js';
import { sendRefusal } from '../helpers/refusal.js';

/** `agency.reports` (`config/blocks/agency.ts`). */
export type AgencyReportsConfig = AppConfig['agency']['reports'];

/** A campaign a report may be about, after the ownership probe. */
export interface ReportCampaignTarget {
  id: string;
  name: string;
  timezone: string;
}

/** Everything the report routes read or write, injectable for tests. */
export interface ReportRouteDeps {
  config: AgencyReportsConfig;
  runs: Pick<ReportRunRepository, 'create' | 'findById' | 'list' | 'countRequestedSince'>;
  subscriptions: Pick<ReportSubscriptionRepository, 'create' | 'update' | 'delete' | 'findById' | 'list'>;
  /** The `agency_reports_enabled` flag for the request's tenant and account. */
  reportsEnabled(request: FastifyRequest): Promise<boolean>;
  /** The campaign ownership probe (tenant AND account), or null when it refuses. */
  campaign(request: FastifyRequest, campaignId: string): Promise<ReportCampaignTarget | null>;
  /** Was this user ever a member of the tenant reaching the account (a supervisor's agent subject)? */
  agentInAccount(userId: string, tenantId: string, accountId: string): Promise<boolean>;
  /** The users among `userIds` with `agency.supervise` on the account now. */
  supervisorsAmong(userIds: readonly string[], tenantId: string, accountId: string): Promise<Set<string>>;
  /** The ids among `campaignIds` that the tenant and account own. */
  ownedCampaignIds(campaignIds: readonly string[], tenantId: string, accountId: string): Promise<Set<string>>;
  names(tenantId: string, refs: readonly ReportNameRef[]): Promise<ReportNames>;
  /** Is the zone in Postgres's zone database (`pg_timezone_names`, case-insensitive)? */
  zoneKnownToDatabase(zone: string): Promise<boolean>;
  presign(key: string, options: PresignOptions): Promise<string>;
  audit(entry: PlatformCreateAuditLogInput): void;
  now(): Date;
}

/** The flag gate's refusal: the dialer gate's body shape (`helpers/dialer-gate.ts`), for reports. */
export const REPORTS_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Reports are not enabled for this account.',
} as const;

/** The 403 of a caller who may not run this kind on this subject (no report code: RBAC's shape). */
export const REPORT_FORBIDDEN_BODY = { error: 'Forbidden', message: 'You do not have permission to run this report.' } as const;

/** The HTTP status of each report refusal code (`packages/contracts/src/errors.ts` §5). */
export const REPORT_ERROR_STATUS: Record<AgencyReportErrorCode, number> = {
  report_window_invalid: 400,
  report_window_too_long: 400,
  report_timezone_invalid: 400,
  report_subject_not_found: 404,
  report_queue_full: 429,
  report_rate_limited: 429,
  report_not_found: 404,
  report_not_ready: 409,
  report_expired: 410,
  report_format_unavailable: 404,
  report_subscription_not_found: 404,
  report_subscription_invalid: 400,
  report_recipient_invalid: 400,
};

/** English fallback copy per code (the console shows its own copy for a known code). */
const REPORT_ERROR_MESSAGES: Record<AgencyReportErrorCode, string> = {
  report_window_invalid: 'The report window is not valid.',
  report_window_too_long: 'A report covers at most 30 days, or exactly one calendar month.',
  report_timezone_invalid: 'The time zone is missing or not recognised.',
  report_subject_not_found: 'Nothing to report on was found with that id in this account.',
  report_queue_full: 'Too many reports are being prepared for this workspace. Try again when one is ready.',
  report_rate_limited: 'Too many reports requested in the last minute. Try again shortly.',
  report_not_found: 'Report not found.',
  report_not_ready: 'The report is not ready to download.',
  report_expired: 'The report has expired and its files have been deleted.',
  report_format_unavailable: 'The report was not prepared in that format.',
  report_subscription_not_found: 'Scheduled report not found.',
  report_subscription_invalid: 'The schedule is not valid for its cadence.',
  report_recipient_invalid: 'A recipient cannot receive this report.',
};

/** `{ error, code, message }` with the code's status. */
export function sendReportRefusal(reply: FastifyReply, code: AgencyReportErrorCode, message?: string): FastifyReply {
  return sendRefusal(reply, REPORT_ERROR_STATUS[code], code, message ?? REPORT_ERROR_MESSAGES[code]);
}

/** The reports flag, else `403 feature_disabled`. False once it has replied. A flag read that throws propagates (fails closed). */
export async function reportsGate(deps: ReportRouteDeps, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await deps.reportsEnabled(request)) return true;
  await reply.code(403).send(REPORTS_DISABLED_BODY);
  return false;
}

/** Does the caller hold `agency.supervise` on the request's account? */
export function callerSupervises(request: FastifyRequest): boolean {
  return hasPermission(request.membership?.role, 'agency.supervise');
}

/** An IANA zone this server can cut days in (`Area/Location` or `UTC`, untrimmed text refused). */
export function isReportTimezone(timezone: unknown): timezone is string {
  return typeof timezone === 'string' && timezone === timezone.trim() && timezone.length <= 64 && isUsableTimezone(timezone);
}

/**
 * A zone a report may be cut in: {@link isReportTimezone} (`Intl`) AND known to Postgres, whose
 * `AT TIME ZONE` the dataset reads cut the window with (`agency/reports/zone.ts`). Else the
 * route answers `report_timezone_invalid` (null here).
 */
export async function usableReportZone(deps: Pick<ReportRouteDeps, 'zoneKnownToDatabase'>, timezone: unknown): Promise<string | null> {
  return isReportTimezone(timezone) && (await deps.zoneKnownToDatabase(timezone)) ? timezone : null;
}

/** What a run or subscription about one subject resolves to, for this caller. */
export interface ReportTarget {
  kind: ReportKind;
  subjectId: string;
  audience: ReportAudience;
  /** The campaign's zone for a campaign report (RP3); null for the others (the request's). */
  campaignTimezone: string | null;
}

/**
 * The caller's reach over a subject (docs/reports.md "Who may run what"), or null once it has
 * replied (403, or 404 `report_subject_not_found`). `supervisorOnly` (subscriptions) refuses the
 * agent's own `self` review.
 *  - agent: `agency.supervise` → the `supervisor` audience, the subject a member (any status) whose
 *    membership reaches the account; else the caller's own id with `agency.station.connect` →
 *    `self`; else 403;
 *  - campaign: `agency.supervise`, then the ownership probe (tenant and account);
 *  - account: `agency.supervise`, and the subject is the context account.
 */
export async function resolveReportTarget(
  deps: ReportRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { kind: ReportKind; subjectId: string; supervisorOnly?: boolean },
): Promise<ReportTarget | null> {
  const tenantId = request.tenantId!;
  const accountId = request.accountId;
  if (!accountId) {
    await sendReportRefusal(reply, 'report_subject_not_found');
    return null;
  }
  const supervises = callerSupervises(request);
  const subjectId = input.subjectId.toLowerCase();
  switch (input.kind) {
    case 'agent': {
      if (supervises) {
        if (!(await deps.agentInAccount(subjectId, tenantId, accountId))) {
          await sendReportRefusal(reply, 'report_subject_not_found');
          return null;
        }
        return { kind: 'agent', subjectId, audience: 'supervisor', campaignTimezone: null };
      }
      if (!input.supervisorOnly && subjectId === request.user?.id.toLowerCase()
        && hasPermission(request.membership?.role, 'agency.station.connect')) {
        return { kind: 'agent', subjectId, audience: 'self', campaignTimezone: null };
      }
      await reply.code(403).send(REPORT_FORBIDDEN_BODY);
      return null;
    }
    case 'campaign': {
      if (!supervises) {
        await reply.code(403).send(REPORT_FORBIDDEN_BODY);
        return null;
      }
      const campaign = await deps.campaign(request, subjectId);
      if (!campaign) {
        await sendReportRefusal(reply, 'report_subject_not_found');
        return null;
      }
      return { kind: 'campaign', subjectId, audience: 'supervisor', campaignTimezone: campaign.timezone };
    }
    case 'account': {
      if (!supervises) {
        await reply.code(403).send(REPORT_FORBIDDEN_BODY);
        return null;
      }
      if (subjectId !== accountId.toLowerCase()) {
        await sendReportRefusal(reply, 'report_subject_not_found');
        return null;
      }
      return { kind: 'account', subjectId, audience: 'supervisor', campaignTimezone: null };
    }
  }
}

/** A run of the request's tenant AND account, or null. */
export async function findAccountRun(deps: ReportRouteDeps, request: FastifyRequest, id: string): Promise<ReportRunRecord | null> {
  const run = await deps.runs.findById(request.tenantId!, id.toLowerCase());
  if (!run || !request.accountId || run.account_id !== request.accountId.toLowerCase()) return null;
  return run;
}

/** May the caller see this run (its detail page, the history)? The requester, or a supervisor of the account. */
export function callerSeesRun(request: FastifyRequest, run: ReportRunRecord): boolean {
  return run.requested_by === request.user?.id || callerSupervises(request);
}

/** Write a platform audit row for the caller (never awaited: the buffer flushes it). */
export function auditReport(
  deps: ReportRouteDeps,
  request: FastifyRequest,
  entry: Pick<PlatformCreateAuditLogInput, 'action' | 'resource_type' | 'resource_id' | 'details'>,
): void {
  deps.audit({
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
    ...requestAuditActor(request),
    ...entry,
  } as PlatformCreateAuditLogInput);
}

/** The production dependencies. */
export function defaultReportRouteDeps(config: AgencyReportsConfig): ReportRouteDeps {
  return {
    config,
    runs: reportRunRepository,
    subscriptions: reportSubscriptionRepository,
    reportsEnabled: (request) => getFeatureFlagService().isEnabled(FLAGS.agency_reports_enabled, {
      tenantId: request.tenantId!,
      ...(request.accountId ? { accountId: request.accountId } : {}),
    }),
    async campaign(request, campaignId) {
      const [probe, row] = await Promise.all([
        fetchOwnedCoreCampaign(request, campaignId),
        agencyCampaignRepository.findById(campaignId),
      ]);
      if (!probe.ok || !row || row.tenant_id !== request.tenantId || row.account_id !== request.accountId) return null;
      return { id: row.id, name: row.name, timezone: row.default_timezone };
    },
    agentInAccount: isMemberOfAccountEver,
    supervisorsAmong: (userIds, tenantId, accountId) =>
      usersWithPermissionOnAccount(userIds, tenantId, accountId, 'agency.supervise'),
    async ownedCampaignIds(campaignIds, tenantId, accountId) {
      const rows = await agencyCampaignRepository.findOwnedSummaries(campaignIds, tenantId, accountId);
      return new Set(rows.map((r) => r.id));
    },
    names: resolveReportNames,
    zoneKnownToDatabase: postgresKnowsZone,
    // Read at call time, not registration: suites that build the app with a partial
    // `storage/s3.js` mock (the load and fuzz suites) must not need this export to register routes.
    presign: (key, opts) => getPresignedUrl(key, opts),
    audit: (entry) => platformAuditLogger.log(entry),
    now: () => new Date(),
  };
}
