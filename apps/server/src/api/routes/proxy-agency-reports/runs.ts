/*
 * The report runs: create, list, read one, download a file, run again. Part of
 * `proxy-agency-reports.routes.ts` (guards and order in its header).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  REPORT_DOWNLOAD_URL_TTL_SECONDS,
  REPORT_FORMAT_CONTENT_TYPES,
  REPORT_FORMATS,
  REPORT_KINDS,
  REPORT_RUN_PAGE_DEFAULT_LIMIT,
  REPORT_RUN_PAGE_MAX_LIMIT,
  reportWindowProblem,
  type AgencyReportDownload,
  type AgencyReportRunPage,
  type ReportFormat,
  type ReportKind,
} from '@magick-agency/contracts/api/agency/reports';
import { reportFileName } from '@magick-agency/contracts/reports';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { decodeKeysetCursor } from '@magick-agency/domain/keyset-cursor';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { UUID_RE } from '../../../utils/uuid.js';
import type { ReportRunRecord } from '../../../db/repositories/agency.repository.js';
import { localDateOf, localDayBounds } from '../../../agency/reports/schedule.js';
import {
  orderedFormats,
  reportSubjectName,
  runNameRef,
  toReportRunWire,
} from '../../../agency/reports/run-view.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import {
  auditReport,
  callerSeesRun,
  callerSupervises,
  findAccountRun,
  isReportTimezone,
  reportsGate,
  resolveReportTarget,
  sendReportRefusal,
  type ReportRouteDeps,
} from './shared.js';

const uuid = z.string().regex(UUID_RE, 'must be a UUID');
const distinct = <T>(items: readonly T[]) => new Set(items).size === items.length;

/** `POST /reports` (`AgencyCreateReportRequest`). Dates and the zone are checked after access, with their own codes. */
const createReportBody = z.object({
  kind: z.enum(REPORT_KINDS),
  subject_id: uuid,
  from: z.string().max(32),
  to: z.string().max(32),
  timezone: z.string().max(64).optional(),
  formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(REPORT_FORMATS.length).refine(distinct, 'formats must be distinct'),
  campaign_ids: z.array(uuid).min(1).max(500).refine(distinct, 'campaign_ids must be distinct').optional(),
  email_me: z.boolean().optional(),
}).strict().refine((b) => b.campaign_ids === undefined || b.kind === 'account', {
  message: 'campaign_ids is for an account report only',
  path: ['campaign_ids'],
});

/** `GET /reports` (`AgencyReportRunListQuery`). */
const listQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(REPORT_RUN_PAGE_MAX_LIMIT).optional(),
  kind: z.enum(REPORT_KINDS).optional(),
  subject_id: uuid.optional(),
  subscription_id: uuid.optional(),
});

type IdParams = { Params: { id: string } };
type FileParams = { Params: { id: string; format: string } };

/** What an ad hoc run is created from: a request body, a retried run, or a subscription's period. */
export interface AdHocRunInput {
  kind: ReportKind;
  subjectId: string;
  from: string;
  to: string;
  /** The request's zone (agent, account); ignored for a campaign (its own zone). */
  timezone: string | undefined;
  formats: ReportFormat[];
  campaignIds: string[] | null;
  emailMe: boolean;
  via: 'request' | 'retry' | 'run_now';
  subscriptionId?: string;
  /** Subscriptions are supervisors' only: refuse the agent's own review. */
  supervisorOnly?: boolean;
}

/**
 * Queue an ad hoc run for the caller after every check (access, zone, window, `campaign_ids`, the
 * per-user rate, the tenant's pending limit), audit it and answer `202` with the run. Shared by
 * create, retry and run-now, so a run is never queued around a check.
 */
export async function createAdHocRun(
  deps: ReportRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: AdHocRunInput,
): Promise<FastifyReply> {
  const target = await resolveReportTarget(deps, request, reply, {
    kind: input.kind,
    subjectId: input.subjectId,
    ...(input.supervisorOnly ? { supervisorOnly: true } : {}),
  });
  if (!target) return reply;
  const tenantId = request.tenantId!;
  const accountId = request.accountId!.toLowerCase();

  const timezone = target.campaignTimezone ?? input.timezone;
  if (!isReportTimezone(timezone)) return sendReportRefusal(reply, 'report_timezone_invalid');

  const now = deps.now();
  const windowProblem = reportWindowProblem(input.from, input.to, localDateOf(now, timezone));
  if (windowProblem) return sendReportRefusal(reply, windowProblem);

  if (input.campaignIds) {
    const owned = await deps.ownedCampaignIds(input.campaignIds, tenantId, accountId);
    if (input.campaignIds.some((id) => !owned.has(id.toLowerCase()))) return sendReportRefusal(reply, 'report_subject_not_found');
  }

  const userId = request.user!.id;
  const recent = await deps.runs.countRequestedSince(tenantId, userId, new Date(now.getTime() - 60_000));
  if (recent >= deps.config.userPerMinute) return sendReportRefusal(reply, 'report_rate_limited');

  const bounds = localDayBounds(input.from, input.to, timezone);
  const created = await deps.runs.create({
    tenantId,
    accountId,
    kind: target.kind,
    subjectId: target.subjectId,
    campaignIds: input.campaignIds ? input.campaignIds.map((id) => id.toLowerCase()) : null,
    localFrom: input.from,
    localTo: input.to,
    timezone,
    rangeFrom: bounds.start,
    rangeTo: bounds.end,
    formats: orderedFormats(input.formats),
    audience: target.audience,
    requestedBy: userId,
    emailMe: input.emailMe,
  }, deps.config.tenantPendingLimit);
  if (!created.ok) return sendReportRefusal(reply, 'report_queue_full');

  const run = created.run;
  auditReport(deps, request, {
    action: 'agency_report.requested',
    resource_type: 'agency_report',
    resource_id: run.id,
    details: {
      via: input.via,
      kind: run.kind,
      subject_id: run.subject_id,
      from: run.local_from,
      to: run.local_to,
      timezone: run.timezone,
      formats: run.formats,
      audience: run.audience,
      ...(input.subscriptionId ? { subscription_id: input.subscriptionId } : {}),
    },
  });
  const names = await deps.names(tenantId, [runNameRef(run)]);
  return reply.code(202).send(toReportRunWire(run, names));
}

/**
 * May the caller download this run's files? The requester, or anyone who could create the same
 * run now (re-checked on every download): a supervisor of the account (for a campaign run, while
 * the account still owns the campaign), or, for an agent's `self` review, the agent themselves.
 */
async function callerMayDownload(deps: ReportRouteDeps, request: FastifyRequest, run: ReportRunRecord): Promise<boolean> {
  if (run.requested_by !== null && run.requested_by === request.user?.id) return true;
  if (run.kind === 'agent' && run.audience === 'self') {
    return run.subject_id === request.user?.id && hasPermission(request.membership?.role, 'agency.station.connect');
  }
  if (!callerSupervises(request)) return false;
  if (run.kind === 'campaign') return (await deps.campaign(request, run.subject_id)) !== null;
  return true;
}

export async function registerReportRunRoutes(app: FastifyInstance, deps: ReportRouteDeps): Promise<void> {
  /** POST /reports — queue an ad hoc run (202). */
  app.post('/reports', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const parsed = parseOr400(createReportBody, request.body, reply, 'agency');
    if (!parsed) return reply;
    const body = parsed.data;
    return createAdHocRun(deps, request, reply, {
      kind: body.kind,
      subjectId: body.subject_id,
      from: body.from,
      to: body.to,
      timezone: body.timezone,
      formats: body.formats,
      campaignIds: body.campaign_ids ?? null,
      emailMe: body.email_me ?? false,
      via: 'request',
    });
  });

  /** GET /reports — the history: a supervisor sees the account's runs, anyone else only their own. */
  app.get('/reports', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    const parsed = parseOr400(listQuery, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const query = parsed.data;
    let after;
    if (query.cursor !== undefined && query.cursor !== '') {
      after = decodeKeysetCursor(query.cursor);
      if (!after) {
        return reply.code(400).send({ error: 'Validation Error', details: { fieldErrors: { cursor: ['not a cursor this API issued'] } } });
      }
    }
    const accountId = request.accountId;
    if (!accountId) return reply.code(200).send({ runs: [], next_cursor: null } satisfies AgencyReportRunPage);
    const page = await deps.runs.list({
      tenantId: request.tenantId!,
      accountId: accountId.toLowerCase(),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.subject_id ? { subjectId: query.subject_id.toLowerCase() } : {}),
      ...(query.subscription_id ? { subscriptionId: query.subscription_id.toLowerCase() } : {}),
      // Whatever the query says: without `agency.supervise`, only the caller's own runs.
      ...(callerSupervises(request) ? {} : { requestedBy: request.user!.id }),
      ...(after ? { after } : {}),
      limit: query.limit ?? REPORT_RUN_PAGE_DEFAULT_LIMIT,
    });
    const names = await deps.names(request.tenantId!, page.rows.map(runNameRef));
    const body: AgencyReportRunPage = { runs: page.rows.map((run) => toReportRunWire(run, names)), next_cursor: page.next_cursor };
    return reply.code(200).send(body);
  });

  /** GET /reports/:id — one run. Another account's, another tenant's, or one the caller may not see: 404. */
  app.get<IdParams>('/reports/:id', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    if (!UUID_RE.test(request.params.id)) return sendReportRefusal(reply, 'report_not_found');
    const run = await findAccountRun(deps, request, request.params.id);
    if (!run || !callerSeesRun(request, run)) return sendReportRefusal(reply, 'report_not_found');
    const names = await deps.names(request.tenantId!, [runNameRef(run)]);
    return reply.code(200).send(toReportRunWire(run, names));
  });

  /** GET /reports/:id/files/:format — a 5-minute presigned URL for one file, audited. */
  app.get<FileParams>('/reports/:id/files/:format', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    if (!UUID_RE.test(request.params.id)) return sendReportRefusal(reply, 'report_not_found');
    const run = await findAccountRun(deps, request, request.params.id);
    if (!run || !(await callerMayDownload(deps, request, run))) return sendReportRefusal(reply, 'report_not_found');
    const format = request.params.format as ReportFormat;
    if (!(REPORT_FORMATS as readonly string[]).includes(format) || !run.formats.includes(format)) {
      return sendReportRefusal(reply, 'report_format_unavailable');
    }
    const now = deps.now();
    if (run.status === 'expired' || (run.status === 'ready' && run.expires_at !== null && new Date(run.expires_at) <= now)) {
      return sendReportRefusal(reply, 'report_expired');
    }
    if (run.status !== 'ready') return sendReportRefusal(reply, 'report_not_ready');
    const file = run.files.find((f) => f.format === format);
    if (!file) return sendReportRefusal(reply, 'report_format_unavailable');

    const names = await deps.names(request.tenantId!, [runNameRef(run)]);
    const filename = reportFileName(
      run.kind,
      reportSubjectName(names, run.kind, run.subject_id) ?? run.subject_id,
      run.local_from,
      run.local_to,
      format,
    );
    const url = await deps.presign(file.key, {
      expiresIn: REPORT_DOWNLOAD_URL_TTL_SECONDS,
      filename,
      contentType: REPORT_FORMAT_CONTENT_TYPES[format],
    });
    auditReport(deps, request, {
      action: 'agency_report.downloaded',
      resource_type: 'agency_report',
      resource_id: run.id,
      details: { format, kind: run.kind, subject_id: run.subject_id, from: run.local_from, to: run.local_to },
    });
    void reply.header('Cache-Control', 'no-store');
    const body: AgencyReportDownload = {
      url,
      filename,
      expires_at: new Date(now.getTime() + REPORT_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
    return reply.code(200).send(body);
  });

  /** POST /reports/:id/retry — "Run again": a NEW ad hoc run with the same parameters, for the caller (202). */
  app.post<IdParams>('/reports/:id/retry', {
    preHandler: requirePermission('agency.station.connect'),
  }, async (request, reply) => {
    if (!(await reportsGate(deps, request, reply))) return reply;
    if (!UUID_RE.test(request.params.id)) return sendReportRefusal(reply, 'report_not_found');
    const run = await findAccountRun(deps, request, request.params.id);
    if (!run || !callerSeesRun(request, run)) return sendReportRefusal(reply, 'report_not_found');
    return createAdHocRun(deps, request, reply, {
      kind: run.kind,
      subjectId: run.subject_id,
      from: run.local_from,
      to: run.local_to,
      timezone: run.timezone,
      formats: run.formats,
      campaignIds: run.campaign_ids,
      // The requester's own choice carries over; anyone else (a supervisor re-running a
      // colleague's or a scheduled run) is not signed up for an email they never asked for.
      emailMe: run.requested_by === request.user!.id ? run.email_me : false,
      via: 'retry',
    });
  });
}
