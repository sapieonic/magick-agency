import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_LISTEN_END_REASON_LABELS,
  AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS,
  type AgencyListenHistoryEntry,
  type AgencyListenHistoryResponse,
} from '@magick-agency/contracts/api/agency/listen-history';
import type { AgencyCallOrigin } from '@magick-agency/contracts/agency';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { ACCOUNT_HEADER } from '../middleware/headers.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore, type CoreCallRequest, type CoreCallResult } from '../core-dispatch.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { maskPhone } from '../../agency/reports/datasets/shared.js';
import { toCsvLine } from '../../agency/agency-csv.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
import { isWithheldNumber } from './helpers/listen.js';
import {
  listenHistoryExportQuerySchema,
  listenHistoryFilterQuery,
  listenHistoryQuerySchema,
  type ListenHistoryFilters,
} from './helpers/listen-history-query.js';
import { drainPages } from './helpers/drain-pages.js';
import { csvAttachmentHeader } from './helpers/csv-attachment.js';
import type { CoreListenHistoryEntry, CoreListenHistoryPage } from './agency/listen-history.js';

const log = createChildLogger({ component: 'proxy-agency-listen-history' });

/*
 * The account's listening history (docs/listening.md §12, LS19; contracts
 * `api/agency/listen-history.ts`), the public layer of B16: the session, the tenant context,
 * `agency.supervise`, an account (`X-Account-Id`), the query validated at the edge. Every read is
 * the internal handler's (`GET /listen-history`, owner `none`) for the request's tenant and account.
 * The listening flag `agency_live_listen_enabled` is NOT read (LS19, amended 2026-11-17): turning
 * listening off stops new listens, not the record of past ones, so neither a flag that is off nor
 * a flag store outage refuses the history.
 *
 *  - `GET /listen-history`: one page of visits (a supervisor's merged sessions on one call), with
 *    the supervisor's and the agent's names and the customer's number masked.
 *  - `GET /listen-history.csv`: every visit the filters keep, the same rows, drained page by page
 *    under a row ceiling and a time budget (`drainPages`; a short file says so in its headers);
 *    numbers masked; audited `agency_listen_sessions.exported` (who, the filters, the rows, any
 *    truncation), as every bulk export here is: the record of who listened is itself sensitive.
 */

/** Pages of this size are drained into the export. */
export const LISTEN_HISTORY_EXPORT_PAGE_SIZE = 100;
/** The export stops between pages past this budget, marked truncated. */
export const LISTEN_HISTORY_EXPORT_TIME_BUDGET_MS = 30_000;

/** What the routes read besides the request. Tests replace it. */
export interface ListenHistoryRouteDeps {
  callCore(req: CoreCallRequest): Promise<CoreCallResult>;
  names(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>>;
  audit: typeof platformAuditLogger.log;
}

export const defaultListenHistoryRouteDeps: ListenHistoryRouteDeps = {
  callCore,
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'listening history'),
  audit: (input) => platformAuditLogger.log(input),
};

function isCorePage(body: unknown): body is CoreListenHistoryPage {
  if (!body || typeof body !== 'object') return false;
  const b = body as { entries?: unknown; next_cursor?: unknown };
  return Array.isArray(b.entries) && (b.next_cursor === null || typeof b.next_cursor === 'string');
}

/** The internal handler refused a page, or answered one this layer cannot read. */
class HistoryReadRefused extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`listening history read refused with ${status}`);
    this.name = 'HistoryReadRefused';
  }
}

/**
 * One visit for the console: names added, the number masked (`maskPhone`). Withheld by the live
 * list's rule (`isWithheldNumber`: no digit at all), so the two agree; null here is a purged call
 * row, not a withheld number, and is neither.
 */
export function toHistoryEntry(e: CoreListenHistoryEntry, names: Map<string, string | null>): AgencyListenHistoryEntry {
  const withheld = e.customer_phone !== null && isWithheldNumber(e.customer_phone);
  return {
    id: e.id,
    listen_ids: e.listen_ids,
    call_id: e.call_id,
    origin: e.origin,
    correlation_id: e.correlation_id,
    campaign_id: e.campaign_id,
    campaign_name: e.campaign_name,
    inbound_route_name: e.inbound_route_name,
    listener_user_id: e.listener_user_id,
    listener_name: names.get(e.listener_user_id) ?? null,
    agent_user_id: e.agent_user_id,
    agent_name: names.get(e.agent_user_id) ?? null,
    customer_name: e.customer_name,
    customer_phone_masked: withheld || e.customer_phone === null ? null : maskPhone(e.customer_phone),
    customer_phone_withheld: withheld,
    started_at: e.started_at,
    ended_at: e.ended_at,
    listened_seconds: e.listened_seconds,
    end_reason: e.end_reason,
  };
}

const CALL_TYPE_WORDS: Record<AgencyCallOrigin, string> = { campaign: 'Dialler', manual: 'Soft phone', inbound: 'Inbound' };

/** The CSV's columns, in order. */
export const LISTEN_HISTORY_CSV_COLUMNS = [
  'started_at', 'ended_at', 'listened_seconds', 'supervisor', 'supervisor_user_id', 'agent', 'agent_user_id',
  'call_type', 'campaign', 'inbound_route', 'customer', 'customer_phone', 'how_it_ended', 'end_reason',
  'sessions', 'call_id', 'listen_ids',
] as const;

/** One CSV line for a visit (formula-guarded by `toCsvLine`). Never a full number. */
export function listenHistoryCsvRow(e: AgencyListenHistoryEntry): string {
  return toCsvLine([
    e.started_at,
    e.ended_at ?? '',
    e.listened_seconds === null ? '' : String(e.listened_seconds),
    e.listener_name ?? '',
    e.listener_user_id,
    e.agent_name ?? '',
    e.agent_user_id,
    CALL_TYPE_WORDS[e.origin] ?? e.origin,
    e.campaign_name ?? '',
    e.inbound_route_name ?? '',
    e.customer_name ?? '',
    e.customer_phone_withheld ? 'Withheld' : e.customer_phone_masked ?? '',
    e.end_reason ? AGENCY_LISTEN_END_REASON_LABELS[e.end_reason] ?? e.end_reason : 'Listening now',
    e.end_reason ?? '',
    String(e.listen_ids.length),
    e.call_id,
    e.listen_ids.join(' '),
  ]);
}

export interface ProxyAgencyListenHistoryOptions {
  deps?: ListenHistoryRouteDeps;
}

export async function proxyAgencyListenHistoryRoutes(
  app: FastifyInstance,
  opts: ProxyAgencyListenHistoryOptions = {},
): Promise<void> {
  const deps = opts.deps ?? defaultListenHistoryRouteDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // Never cached by a browser or a proxy, refusals included: the history names supervisors and customers (masked), the page as much as the export.
  app.addHook('onRequest', async (_request, reply) => { void reply.header('Cache-Control', 'no-store'); });

  /** The account, or a reply. Runs after the permission; no flag (LS19, amended 2026-11-17). */
  async function gate(request: FastifyRequest, reply: FastifyReply): Promise<{ tenantId: string; accountId: string } | null> {
    if (!request.accountId) {
      await reply.code(400).send({ error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` });
      return null;
    }
    return { tenantId: request.tenantId!.toLowerCase(), accountId: request.accountId.toLowerCase() };
  }

  /** One page from the internal handler, named and masked. Throws {@link HistoryReadRefused}. */
  async function readPage(
    scope: { tenantId: string; accountId: string },
    query: Record<string, string>,
  ): Promise<AgencyListenHistoryResponse> {
    const result = await deps.callCore({ method: 'GET', path: '/agency/listen-history', query, ...scope });
    if (result.status !== 200) throw new HistoryReadRefused(result.status, result.body);
    if (!isCorePage(result.body)) {
      log.error({ tenantId: scope.tenantId }, 'listening history: the internal handler answered an unrecognised body');
      throw new HistoryReadRefused(502, { error: 'Bad Gateway', message: 'The listening history could not be read.' });
    }
    const page = result.body;
    const names = await deps.names(page.entries.flatMap((e) => [e.listener_user_id, e.agent_user_id]), scope.tenantId);
    return { entries: page.entries.map((e) => toHistoryEntry(e, names)), next_cursor: page.next_cursor };
  }

  function validationError(reply: FastifyReply, message: string | undefined): FastifyReply {
    return reply.code(400).send({ error: 'Validation Error', message: message ?? 'Invalid query' });
  }

  // ── GET /listen-history ───────────────────────────────────────────────────
  app.get('/listen-history', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const scope = await gate(request, reply);
    if (!scope) return reply;
    const parsed = listenHistoryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return validationError(reply, parsed.error.issues[0]?.message);
    const q = parsed.data;
    const query = {
      ...listenHistoryFilterQuery(q),
      ...(q.limit !== undefined ? { limit: String(q.limit) } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    };
    try {
      return reply.send(await readPage(scope, query));
    } catch (err) {
      if (err instanceof HistoryReadRefused) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  // ── GET /listen-history.csv ───────────────────────────────────────────────
  app.get('/listen-history.csv', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const scope = await gate(request, reply);
    if (!scope) return reply;
    const parsed = listenHistoryExportQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return validationError(reply, parsed.error.issues[0]?.message);
    const filters: ListenHistoryFilters = parsed.data;
    const base = listenHistoryFilterQuery(filters);

    let drained: Awaited<ReturnType<typeof drainPages<string, AgencyListenHistoryEntry, 'deadline'>>>;
    try {
      drained = await drainPages<string, AgencyListenHistoryEntry, 'deadline'>({
        first: null,
        fetchPage: async (cursor) => {
          const page = await readPage(scope, {
            ...base, limit: String(LISTEN_HISTORY_EXPORT_PAGE_SIZE), ...(cursor ? { cursor } : {}),
          });
          return { rows: page.entries, next: page.next_cursor };
        },
        header: toCsvLine([...LISTEN_HISTORY_CSV_COLUMNS]),
        renderRow: listenHistoryCsvRow,
        maxRows: AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS,
        budgetMs: LISTEN_HISTORY_EXPORT_TIME_BUDGET_MS,
        deadlineReason: 'deadline',
        onDeadline: (rows) => log.warn(
          { tenantId: scope.tenantId, rows, budgetMs: LISTEN_HISTORY_EXPORT_TIME_BUDGET_MS },
          'listening history: export exceeded its time budget; serving what was assembled, marked truncated',
        ),
      });
    } catch (err) {
      // A refused page is the answer; a half-written file never reaches a 200.
      if (err instanceof HistoryReadRefused) return reply.code(err.status).send(err.body);
      throw err;
    }

    // Written on the success path only, after the row count is known: what actually left.
    deps.audit({
      tenant_id: scope.tenantId,
      account_id: scope.accountId,
      ...requestAuditActor(request),
      action: 'agency_listen_sessions.exported',
      resource_type: 'account',
      resource_id: scope.accountId,
      details: {
        rows: drained.rowCount,
        filters: { ...base },
        ...(drained.truncated ? { truncated: drained.truncated } : {}),
      },
    });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', csvAttachmentHeader(`listening-history-${new Date().toISOString().slice(0, 10)}`));
    reply.header('X-Export-Rows', String(drained.rowCount));
    if (drained.truncated) {
      reply.header('X-Export-Truncated', 'true');
      reply.header('X-Export-Truncated-Reason', drained.truncated);
      if (drained.truncated === 'row_limit') reply.header('X-Export-Row-Limit', String(AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS));
    }
    return reply.send(drained.lines.join(''));
  });
}
