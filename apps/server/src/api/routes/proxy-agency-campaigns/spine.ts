/*
 * The attempt spine: the attempt and contact lists, one contact, and both CSV exports.
 * Part of `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore, forwardCore } from '../../core-dispatch.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { resolveAgentNames } from '../../../agency/agency-agent-identity.js';
import {
  ATTEMPT_QUERY_PARAMS,
  CONTACT_QUERY_PARAMS,
  PAGING_QUERY_PARAMS,
  SPINE_EXPORT_MAX_ROWS,
  SPINE_EXPORT_PAGE_SIZE,
  SPINE_EXPORT_TIME_BUDGET_MS,
  asSpinePage,
  attemptCsvHeader,
  attemptCsvRow,
  buildSpineCsvPreamble,
  contactCsvHeader,
  contactCsvRow,
  enrichAttemptAgentNames,
  forwardAllowedQuery,
  unknownQueryParamsError,
  PREAMBLE_QUERY_PARAMS,
  type SpineAttemptRow,
  type SpineContactRow,
  type SpineExportTruncation,
} from '../../../agency/agency-spine.js';
import { drainPages } from '../helpers/drain-pages.js';
import { csvAttachmentHeader } from '../helpers/csv-attachment.js';
import { requireOwnedCampaign } from './ownership.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

/**
 * Ceiling on one filter VALUE as recorded in an export's audit row.
 *
 * Generous next to any real filter (a disposition code, an E.164 number, an
 * ISO timestamp) and far below anything that would bloat the audit store.
 */
export const AUDIT_FILTER_VALUE_MAX_CHARS = 200;

/**
 * The internal handler refused a page mid-export.
 *
 * Thrown rather than returned so the drain loop stops where it is and the
 * caller forwards the handler's own status unchanged — a 404 for a campaign the
 * caller does not own, a 400 for a filter the handler rejected. The half-written
 * file is discarded: a short CSV sent under a 200 is the one outcome an export
 * must never produce, because nothing about it says it is short.
 *
 * `callCore` runs in-process with no socket and no abort signal, so there is no
 * per-page timeout error to recognise here. See `drainSpineExport`.
 */
class SpineExportRefused extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`agency spine export refused with ${status}`);
    this.name = 'SpineExportRefused';
  }
}

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignSpineRoutes(app: FastifyInstance): Promise<void> {
  // ── The attempt spine: what the campaign did, and to whom ────────────────────
  //
  // Thin pass-throughs. Unlike `/activity` above there is no second table to
  // merge and no aggregation — the dialer runtime owns `agency_call_attempts` and
  // `agency_contacts` outright, and the internal handler's `requireOwned` answers
  // 404 for a campaign in another tenant or account, which is forwarded unchanged
  // so a cross-tenant id and a nonexistent one stay indistinguishable.
  //
  // ── Gated on `agency.supervise`, not on `audit.read` ───────────────────────
  // The two are the same ROLE floor (`account_admin`), so this is not about who
  // gets in — it is about which question the permission names. `audit.read`
  // covers the control plane: who started, paused and stopped the campaign.
  // This is the operational record: what was dialled, to whom, with what result.
  // A tenant that later narrows one of the two must be able to narrow it without
  // silently taking the other away.
  //
  // ── The three privacy decisions, made here rather than left to the render ──
  //
  // 1. `context` — the contact's raw CSV columns — is NOT reachable through
  //    either list or either export. The internal handler serves it only on the
  //    single-contact drill-down, so the exclusion is structural rather than a
  //    column somebody remembered to leave out. Columns an operator marked
  //    `Ignore` at ingest never reach the stored JSONB at all
  //    (`agency-csv-ingest.ts` drops them before the row is written), so the
  //    rule that "a field in `context` is a field on an agent's screen the
  //    moment anyone changes the render rules" is enforced where it should be.
  //    `context_display.hidden` remains a render rule and the console honours it
  //    on the drill-down.
  //
  // 2. **Phone numbers are served in full, and the export needs no extra gate.**
  //    Phone masking is not implemented anywhere yet; inventing a second
  //    masking rule for this one surface — one the agent floor would not share —
  //    is how two rules drift. The `agency.supervise` floor is `account_admin`,
  //    which is also the floor for the DNC list and the roster upload, so the
  //    number is not new information to this reader. What IS new is bulk, and
  //    that is answered with **attribution rather than a second permission**:
  //    every export writes an audit row naming the actor, the filters and the
  //    row count. A second gate to keep aligned with the first is a second gate
  //    to drift — the same reasoning that declined to mint a permission for the
  //    activity trail.
  //
  // 3. `notes` — agent-typed free text — ARE included, on the list and in the
  //    export. They are deliberately excluded from the AUDIT trail (an audit row
  //    records the catalog code, not customer content, see the disposition route
  //    in `proxy-agency-agent.routes.ts`). This is not the audit trail: notes are
  //    operational content on the contact record, and they are frequently the
  //    answer to "why was this number called four times".

  app.get<{ Params: { id: string } }>('/campaigns/:id/attempts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Refused before `callCore`, so the 400 is not masked as a handler error.
    const forwarded = forwardAllowedQuery(request.query, [...ATTEMPT_QUERY_PARAMS, ...PAGING_QUERY_PARAMS]);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/attempts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    // The internal handler serves only the agent's USER id; names come from the
    // user directory, resolved here, and a column of UUIDs is not a column a
    // supervisor can read or filter by.
    // Non-2xx bodies pass through untouched so an error reaches the error mask
    // exactly as the handler wrote it.
    const body = result.status >= 200 && result.status < 300
      ? await enrichAttemptAgentNames(result.body, request.tenantId!, resolveAgentNames, (err) => {
        log.warn(
          { tenantId: request.tenantId, err: err instanceof Error ? err.message : String(err) },
          'agency spine: agent name resolution failed; emitting agent_name: null',
        );
      })
      : result.body;
    return reply.code(result.status).send(body);
  });

  /**
   * The roster: the read of what roster ingest (`sendRosterChunk`) wrote.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/contacts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const forwarded = forwardAllowedQuery(request.query, [...CONTACT_QUERY_PARAMS, ...PAGING_QUERY_PARAMS]);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/contacts`,
      query: forwarded.query,
    });
  });

  /**
   * One contact, with its uploaded CSV columns — the drill-down's row, and the
   * only route on this surface that carries `context`.
   *
   * Deliberately **one contact at a time**: that is what keeps the columns off
   * the list and out of the export by construction rather than by a filter
   * someone has to remember to apply. A console rendering `context` must apply
   * the campaign's `context_display.hidden` exactly as the agent screen does.
   */
  app.get<{ Params: { id: string; contactId: string } }>('/campaigns/:id/contacts/:contactId', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/contacts/${request.params.contactId}`,
    });
  });

  /**
   * `?preamble=false` — case-insensitively, because the preamble's own
   * instruction text is the only place a caller reads the spelling from and an
   * uppercase `FALSE` silently kept the block.
   */
  function wantsPreamble(query: unknown): boolean {
    const raw = (query as { preamble?: unknown } | undefined)?.preamble;
    return String(raw ?? '').toLowerCase() !== 'false';
  }

  /**
   * Cap what a caller can write into the audit row through a filter value.
   *
   * Not a validation step — the filter itself was already forwarded to the
   * internal handler, which accepted or refused it on its own terms. This bounds the AUDIT
   * record, which is append-only, retained, and read by people investigating
   * something else.
   */
  function boundedFilters(filters: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      out[key] = value.length > AUDIT_FILTER_VALUE_MAX_CHARS
        // Marked, not silently cut: a truncated value that looks whole would
        // misreport what the export actually covered.
        ? `${value.slice(0, AUDIT_FILTER_VALUE_MAX_CHARS)}…[truncated]`
        : value;
    }
    return out;
  }

  // ── The exports ───────────────────────────────────────────────────────────

  /**
   * Drain one of the internal handler's keyset-paginated lists into a CSV.
   *
   * Shared by both exports, and its loop is `drainPages`, the activity export's too:
   * everything that is hard here — the deadline consulted between pages, the row
   * ceiling, discarding rather than appending a refused page — is identical for all
   * three, and a second copy is a second place for the budget arithmetic to be
   * subtly wrong.
   *
   * Every page carries `provenCampaignId`: the caller has already proved ownership
   * on this request (`requireOwnedCampaign`), so the handler does not repeat its
   * flag read and campaign read on each of up to 100 pages.
   *
   * There is no merge here: the internal handler is the only source, so a page
   * it refuses produces no file at all — an error, which is already unambiguous
   * — rather than a quietly half-populated one.
   */
  async function drainSpineExport<TRow>(params: {
    request: FastifyRequest<{ Params: { id: string } }>;
    path: string;
    filters: Record<string, string>;
    header: string;
    renderRow: (row: TRow) => string;
    /**
     * Applied per page, before rendering. The attempts export uses it to put
     * agent names on the rows — the export has to carry what the screen does,
     * and the enrichment is a per-page lookup rather than a per-row one.
     */
    enrich?: (body: unknown) => Promise<unknown>;
  }): Promise<{ lines: string[]; rowCount: number; truncated: SpineExportTruncation | null }> {
    return drainPages<string, TRow, 'deadline'>({
      first: null,
      fetchPage: async (cursor) => {
        // No per-page budget: `callCore` runs in-process with no socket and no abort
        // signal, and a throw from it is a wiring defect that propagates. The
        // between-pages deadline bounds a slow drain, and the row ceiling bounds a
        // large one.
        const query: Record<string, string> = {
          ...params.filters,
          limit: String(SPINE_EXPORT_PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        };
        const result = await callCore({
          method: 'GET',
          path: params.path,
          query,
          tenantId: params.request.tenantId!,
          accountId: params.request.accountId,
          // Proved by the caller's `requireOwnedCampaign` probe on this request, with
          // these same tenant and account, before the drain started: each page skips
          // the handler's flag read and campaign read (`spinePageCampaignId`).
          provenCampaignId: params.request.params.id,
        });
        if (result.status >= 400) {
          // The handler's refusal is the answer — a 400 for a filter it rejected.
          // Thrown rather than returned so the caller forwards the status unchanged;
          // a half-written file must never be sent under a 200.
          throw new SpineExportRefused(result.status, result.body);
        }

        const enriched = params.enrich ? await params.enrich(result.body) : result.body;
        const page = asSpinePage<TRow>(enriched);
        if (!page) {
          throw new SpineExportRefused(502, {
            error: 'Bad Gateway',
            code: 'spine_export_unreadable',
            message: 'The voice service returned a page this export could not read. Nothing was exported.',
          });
        }
        return { rows: page.rows, next: page.next_cursor };
      },
      header: params.header,
      renderRow: params.renderRow,
      maxRows: SPINE_EXPORT_MAX_ROWS,
      budgetMs: SPINE_EXPORT_TIME_BUDGET_MS,
      deadlineReason: 'deadline',
      onDeadline: (rows) => log.warn(
        {
          campaignId: params.request.params.id,
          rows,
          budgetMs: SPINE_EXPORT_TIME_BUDGET_MS,
        },
        'agency spine: export exceeded its time budget; serving what was assembled, marked truncated',
      ),
    });
  }

  /**
   * Finish an export: preamble, headers, audit row, body.
   *
   * ── The audit row is what stands in for a second permission ────────────────
   * A bulk export of every number on a campaign is a materially larger exposure
   * than one number in one drawer, and the decision is that it is answered with
   * attribution rather than with a gate nobody would know to grant. Written only on the success path, after the row count is
   * known, so it records what actually left the building — including that it was
   * truncated, since "50,000 rows of 1,000,000" is a different disclosure from
   * "the whole campaign" and a reviewer must be able to tell them apart.
   */
  function sendSpineCsv(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    input: {
      kind: 'attempts' | 'contacts';
      lines: string[];
      rowCount: number;
      truncated: SpineExportTruncation | null;
      preamble: boolean;
      filters: Record<string, string>;
      campaignName: string | null;
      coreAccountId: string;
    },
  ) {
    const lines = [...input.lines];
    // Built LAST and unshifted onto the front: the row count and the truncation
    // are only known once the drain has finished, and a preamble asserting
    // completeness before that would be the one lie this file must not tell.
    if (input.preamble) {
      lines.unshift(...buildSpineCsvPreamble({
        kind: input.kind,
        generatedAt: new Date(),
        campaignId: request.params.id,
        campaignName: input.campaignName,
        tenantId: request.tenantId!,
        accountId: input.coreAccountId,
        filters: input.filters,
        rowCount: input.rowCount,
        truncated: input.truncated,
        rowLimit: SPINE_EXPORT_MAX_ROWS,
      }));
    }

    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: input.kind === 'attempts' ? 'agency_attempts.exported' : 'agency_contacts.exported',
      resource_type: 'agency_campaign',
      resource_id: request.params.id,
      campaign_id: request.params.id,
      details: {
        campaign_id: request.params.id,
        rows: input.rowCount,
        // The filters, so the row count can be read as coverage rather than as
        // a bare number.
        //
        // ⚠️ Only the KEYS are whitelisted — `forwardAllowedQuery` validates
        // no value, and `disposition_code` is deliberately un-vocabularied in the
        // dialer runtime (catalogs are per campaign). So the values ARE
        // caller-controlled and are truncated before they reach the audit store:
        // a 200KB filter value landed here unclipped, repeatable, on the one trail
        // a compliance reader depends on.
        filters: boundedFilters(input.filters),
        ...(input.truncated ? { truncated: input.truncated } : {}),
      },
    });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', csvAttachmentHeader(`${input.kind}-${input.campaignName ?? 'campaign'}`));
    reply.header('X-Export-Rows', String(input.rowCount));
    if (input.truncated) {
      reply.header('X-Export-Truncated', 'true');
      reply.header('X-Export-Truncated-Reason', input.truncated);
      // Only where the ceiling is what stopped it. On a deadline this number
      // would describe a file that does not exist.
      if (input.truncated === 'row_limit') {
        reply.header('X-Export-Row-Limit', String(SPINE_EXPORT_MAX_ROWS));
      }
    }
    return reply.send(lines.join(''));
  }

  app.get<{ Params: { id: string } }>('/campaigns/:id/attempts.csv', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // `preamble` is consumed here (`wantsPreamble` below) and deliberately never
    // forwarded to the internal handler, so it must not read as an unknown param.
    const forwarded = forwardAllowedQuery(request.query, ATTEMPT_QUERY_PARAMS, PREAMBLE_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const filters = forwarded.query;

    // Resolved for the preamble's chain-of-custody block and the filename, and
    // the ownership proof the drain's pages carry (`provenCampaignId`): an unowned
    // campaign is refused here, before any page is read.
    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    try {
      const drained = await drainSpineExport<SpineAttemptRow>({
        request,
        path: `/agency-campaigns/${request.params.id}/attempts`,
        filters,
        header: attemptCsvHeader(),
        renderRow: attemptCsvRow,
        enrich: (body) => enrichAttemptAgentNames(
          body, request.tenantId!, resolveAgentNames,
          (err) => log.warn(
            { tenantId: request.tenantId, err: err instanceof Error ? err.message : String(err) },
            'agency spine: agent name resolution failed during export; emitting blank agent_name',
          ),
        ),
      });
      return sendSpineCsv(request, reply, {
        kind: 'attempts',
        ...drained,
        preamble: wantsPreamble(request.query),
        filters,
        campaignName: owned.name,
        // The campaign row's account (`requireOwnedCampaign`), always present.
        coreAccountId: owned.accountId,
      });
    } catch (err: unknown) {
      if (err instanceof SpineExportRefused) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/campaigns/:id/contacts.csv', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const forwarded = forwardAllowedQuery(request.query, CONTACT_QUERY_PARAMS, PREAMBLE_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const filters = forwarded.query;

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    try {
      const drained = await drainSpineExport<SpineContactRow>({
        request,
        path: `/agency-campaigns/${request.params.id}/contacts`,
        filters,
        header: contactCsvHeader(),
        renderRow: contactCsvRow,
      });
      return sendSpineCsv(request, reply, {
        kind: 'contacts',
        ...drained,
        preamble: wantsPreamble(request.query),
        filters,
        campaignName: owned.name,
        // The campaign row's account (`requireOwnedCampaign`), always present.
        coreAccountId: owned.accountId,
      });
    } catch (err: unknown) {
      if (err instanceof SpineExportRefused) return reply.code(err.status).send(err.body);
      throw err;
    }
  });
}
