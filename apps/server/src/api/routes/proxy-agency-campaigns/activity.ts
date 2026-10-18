/*
 * The merged campaign activity trail and its CSV export. Part of
 * `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_EXPORT_MAX_ROWS,
  ACTIVITY_EXPORT_PAGE_SIZE,
  ACTIVITY_EXPORT_TIME_BUDGET_MS,
  ACTIVITY_MAX_LIMIT,
  activityCsvHeader,
  activityCsvRow,
  buildActivityCsvPreamble,
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityCursor,
  type ActivityRow,
  type ActivityCsvPreambleRetention,
  type ActivityExportTruncation,
} from '../../../agency/agency-activity.js';
import { CAMPAIGN_ACTIVITY_ACTIONS } from '../../../agency/agency-activity-actions.js';
import { fetchActivityPage } from '../../../agency/agency-activity.service.js';
import { drainPages } from '../helpers/drain-pages.js';
import { csvAttachmentHeader } from '../helpers/csv-attachment.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { requireOwnedCampaign } from './ownership.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

/**
 * `action` accepts repeats (`?action=a&action=b`) and comma-separated values in
 * one param, because both are in the wild and a client that guesses wrong would
 * otherwise filter on the literal string `"a,b"` and get an empty trail it would
 * read as "nothing happened".
 *
 * The same list goes to both tables. Their vocabularies overlap but are not
 * equal — only the dialer runtime writes `agency_campaign.auto_paused` (to
 * `audit_logs`), only this layer writes `agency_disposition.created` (to
 * `platform_audit_log`) — so each simply returns what it has, and no mapping
 * table has to be kept in step between them.
 */
const actionFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts : undefined;
  });

const activityPeriodSchema = {
  action: actionFilterSchema,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

/**
 * An inverted range is the CALLER's mistake and must read as one.
 *
 * This is the only check on it: `audit_logs` is queried directly, so without
 * this refusal an inverted range returns an empty Dialer half rather than an
 * error, and an empty trail reads as "nothing happened". `from > to` is
 * refused; `from === to` is allowed (the list routes' `to` is inclusive).
 */
const orderedPeriod = (q: { from?: string; to?: string }): boolean =>
  !(q.from && q.to) || new Date(q.from) <= new Date(q.to);

const ORDERED_PERIOD_ISSUE = {
  message: '`from` must not be later than `to`',
  path: ['to'],
};

// `.refine()` is applied to each schema directly rather than through a shared
// generic helper: routing an object schema through `z.ZodType<T>` infers `T`
// from the INPUT side, which silently widened `action` back to its
// pre-transform `string | string[]` and broke the call site's typing.
const activityQuerySchema = z.object({
  ...activityPeriodSchema,
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
}).refine(orderedPeriod, ORDERED_PERIOD_ISSUE);

/**
 * The `#`-comment preamble in front of the header row (see
 * `agency-activity.ts`), on by default. `false`/`'false'` is the only spelling
 * that turns it off — an unrecognised value falls through to `z.boolean()` and
 * 400s rather than being silently read as "on", the same "refuse, don't guess"
 * posture the rest of this route's query parsing takes.
 */
const preambleQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return true;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}, z.boolean());

/** The export walks the whole filtered trail, so it takes no cursor and no limit. */
const activityExportQuerySchema = z.object({
  ...activityPeriodSchema,
  preamble: preambleQuerySchema,
})
  .refine(orderedPeriod, ORDERED_PERIOD_ISSUE);

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignActivityRoutes(app: FastifyInstance): Promise<void> {
  // ── Activity: the merged audit trail ──────────────────────────────────────

  /**
   * GET /proxy/agency/campaigns/:id/activity — one merged, time-ordered trail.
   *
   * `audit.read`, floored at `account_admin`, the same floor as
   * `agency.supervise`, so the supervisor who controls a campaign can read its
   * trail. No new permission — a second gate to keep aligned is a second gate to
   * drift.
   *
   * ── Both tables hold some of the same action names, and that is right ─────
   * `agency_campaign.paused` appears in `platform_audit_log` (a supervisor
   * pressed Pause) and in `audit_logs` (the campaign actually transitioned).
   * Neither is redundant and `source` is what tells them apart. The rows only
   * the dialer runtime writes — the auto-pause with its measured rate — are what
   * a compliance reviewer came for.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/activity', {
    preHandler: requirePermission('audit.read'),
  }, async (request, reply) => {
    const parsed = parseOr400(activityQuerySchema, request.query, reply, 'agency');
    if (!parsed) return reply;
    const query = parsed.data;

    let cursor: ActivityCursor = { master: null, core: null };
    if (query.cursor) {
      const decoded = decodeActivityCursor(query.cursor);
      if (!decoded) {
        // Refused rather than reset to page one. A cursor that quietly restarts
        // the trail from the top reads as duplicate rows to a reviewer scrolling
        // through it, and there is no way to tell that from real duplicates.
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Malformed cursor',
        });
      }
      cursor = decoded;
    }

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    const page = await fetchActivityPage({
      tenantId: request.tenantId!,
      campaignId: request.params.id,
      // The campaign row's own account, proven above (see `requireOwnedCampaign`).
      accountId: owned.accountId,
      ...(query.action ? { actions: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      limit: query.limit ?? ACTIVITY_DEFAULT_LIMIT,
      cursor,
    });

    return reply.send({
      rows: page.rows,
      next_cursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
      total: page.total,
      // Always present, both of them. A `partial` key that only appeared when
      // something was wrong is indistinguishable from a client that forgot to
      // read it, which is how a silently short list ships looking complete.
      partial: page.partial,
      partial_reason: page.partial_reason,
      retention: page.retention,
      // The vocabulary the `?action=` filter can be built from, served with the
      // data it filters. The server is the only side that knows both tables'
      // action names, so a client keeping its own copy is keeping a copy of
      // something it cannot check — see `agency-activity-actions.ts`.
      //
      // On every response: the list is static and depends on neither read.
      available_actions: CAMPAIGN_ACTIVITY_ACTIONS,
    });
  });

  /**
   * GET /proxy/agency/campaigns/:id/activity.csv — the same trail as a file.
   *
   * CSV because that is the format a compliance request actually arrives asking
   * for, and the merge is already assembled here.
   *
   * ── The file is whole or the request fails ────────────────────────────────
   * The screen could carry a banner saying the trail is incomplete; a file that
   * leaves the building cannot. An export that silently omitted the Dialer half —
   * every status transition and every auto-pause — would be indistinguishable
   * from a complete one to whoever opens it next, possibly months later and in
   * another organisation. `fetchActivityPage` returns a whole page or throws
   * (`partial` is always `false`), so a failed read fails the export.
   *
   * ── Two ways to stop early, and both must say so ──────────────────────────
   * The row ceiling is a runaway guard, not a routine limit (a campaign's
   * control trail is tens to low hundreds of rows); the wall-clock budget bounds
   * the case the ceiling cannot, a database that answers slowly rather than
   * failing, where the loop stays legal and simply runs long. Either way the file that
   * results is short, and a short compliance export handed over as a complete
   * one is the failure this whole surface exists to prevent — so both set
   * `X-Activity-Truncated`, which is the header an already-shipped client
   * checks, and `X-Activity-Truncated-Reason` names which one it was.
   *
   * The reason is a separate header rather than a different value of the first,
   * precisely so a client that only knows `X-Activity-Truncated: true` still
   * refuses to treat the file as whole. `X-Activity-Row-Limit` stays on the
   * row-ceiling path alone: on a deadline the ceiling is not what stopped the
   * export, and reporting it would tell the operator the file holds 5000 rows
   * when it may hold 300. The two need different remedies too — "narrow the date
   * range" fixes a ceiling hit and does nothing for a slow database.
   *
   * The budget is checked between pages only; there is no per-page timeout.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/activity.csv', {
    preHandler: requirePermission('audit.read'),
  }, async (request, reply) => {
    const parsed = parseOr400(activityExportQuerySchema, request.query, reply, 'agency');
    if (!parsed) return reply;
    const query = parsed.data;

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    const filters = {
      tenantId: request.tenantId!,
      campaignId: request.params.id,
      // The campaign row's own account (see `requireOwnedCampaign`).
      accountId: owned.accountId,
      ...(query.action ? { actions: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      // Not the interactive page size: this loop is draining a trail, not
      // rendering one, and each page is two audit SELECTs plus an identity
      // lookup. At 99 a full 5000-row export would be ~51 of those; at 500 it
      // is ~10.
      limit: ACTIVITY_EXPORT_PAGE_SIZE,
      // Nothing here reads `total`, and asking for it costs a `COUNT(*)` over a
      // partitioned table on BOTH sides of the merge, once per page.
      skipTotal: true,
    };

    // Whichever page's retention this export last saw. Retention does not
    // move mid-export, so the last successful page's value is as good as the
    // first's.
    let retention: ActivityCsvPreambleRetention | null = null;

    // The row ceiling and the between-pages budget are `drainPages`'s, shared with
    // the spine exports below.
    const drained = await drainPages<ActivityCursor, ActivityRow, 'time_limit'>({
      first: { master: null, core: null },
      fetchPage: async (cursor) => {
        const page = await fetchActivityPage({ ...filters, cursor: cursor! });
        retention = page.retention;
        return { rows: page.rows, next: page.nextCursor };
      },
      header: activityCsvHeader(),
      renderRow: activityCsvRow,
      maxRows: ACTIVITY_EXPORT_MAX_ROWS,
      budgetMs: ACTIVITY_EXPORT_TIME_BUDGET_MS,
      deadlineReason: 'time_limit',
      onDeadline: (rows) => log.warn(
        { campaignId: request.params.id, rows, budgetMs: ACTIVITY_EXPORT_TIME_BUDGET_MS },
        'agency activity: export exceeded its time budget; serving what was assembled, marked truncated',
      ),
    });
    const { lines, rowCount } = drained;
    const truncatedBy: ActivityExportTruncation | null = drained.truncated;

    // The preamble is built LAST and unshifted onto the front, deliberately.
    // Truncation and the final row count are only known once the loop above
    // has finished, but the preamble has to be the first thing in the file —
    // building it up front would mean asserting completeness before the loop
    // had run, which is exactly the lie this route exists to refuse to tell.
    if (query.preamble) {
      lines.unshift(...buildActivityCsvPreamble({
        generatedAt: new Date(),
        campaignId: request.params.id,
        campaignName: owned.name,
        tenantId: request.tenantId!,
        // The campaign row's account, always present (see `requireOwnedCampaign`).
        accountId: owned.accountId,
        actions: query.action ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        rowCount,
        truncated: truncatedBy,
        rowLimit: ACTIVITY_EXPORT_MAX_ROWS,
        retention,
      }));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    // The campaign's own name, quote-safe in `filename=` and whole (non-ASCII
    // included) in `filename*=` — see `csvAttachmentHeader`.
    reply.header('Content-Disposition', csvAttachmentHeader(`activity-${owned.name ?? 'campaign'}`));
    reply.header('X-Activity-Rows', String(rowCount));
    if (truncatedBy) {
      reply.header('X-Activity-Truncated', 'true');
      reply.header('X-Activity-Truncated-Reason', truncatedBy);
      // Only where the ceiling is what stopped it. On a deadline this number
      // would describe a file that does not exist.
      if (truncatedBy === 'row_limit') {
        reply.header('X-Activity-Row-Limit', String(ACTIVITY_EXPORT_MAX_ROWS));
      }
    }
    return reply.send(lines.join(''));
  });
}
