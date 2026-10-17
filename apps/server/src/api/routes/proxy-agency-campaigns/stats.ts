/*
 * The campaign's live stats strip (name-enriched) and its stats series. Part of
 * `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { enrichAgencyCampaignStats } from '../../../agency/agency-stats-enrichment.js';
import { forwardAllowedQuery, unknownQueryParamsError } from '../../../agency/agency-spine.js';
import {
  CAMPAIGN_SERIES_BUCKETS,
  CAMPAIGN_SERIES_MAX_WINDOW_DAYS,
  CAMPAIGN_SERIES_QUERY_PARAMS,
  MS_PER_DAY,
  parseSeriesInstant,
  resolveSeriesQuery,
} from '../../../agency/agency-campaign-wire.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

/**
 * `?from=&to=&bucket=` on the campaign stats SERIES read.
 *
 * ── Half-open `[from, to)`, and the neighbour above is the other convention ──
 * `from` is inclusive, `to` is EXCLUSIVE. That is the convention of the agent
 * `/my-stats` series — a half-open window is the only shape that tiles, so
 * consecutive requests `[Mon, Tue)` and `[Tue, Wed)` cover Tuesday exactly once,
 * which is what lets a chart page a month at a time and still sum. The attempt
 * and activity LIST routes on this same plugin use an INCLUSIVE `to`
 * ({@link orderedPeriod}, which therefore permits `from === to`), and that is
 * right for a "show me up to here" filter and wrong for an aggregate anybody
 * might add up. The two are invisibly different in a URL, so this is stated
 * rather than assumed — and it is why this schema does not reuse
 * `activityPeriodSchema`.
 *
 * Both bounds are REQUIRED, matching `parseAgentStatsQuery`: this read
 * aggregates and has no page, so an absent bound means "every day of this
 * campaign in one payload", and a defaulted window is worse than a refusal
 * because the caller cannot tell from the response which window they got. It is
 * also what makes the day cap enforceable at all.
 *
 * `bucket` is optional and NOT defaulted here — the internal handler defaults
 * it to `day` and echoes it back, so there is no way for a caller to be wrong
 * about which grouping they got. Validated against the enum regardless, because
 * an unknown bucket is a caller error that should not cost a handler call.
 *
 * Refusals are `{ error: 'Validation Error', details }` like every other query
 * schema on this plugin: this layer's own 4xx precedes any `callCore`, so
 * `errorMaskHook` leaves it alone, and `details` carries the offending param to
 * the client either way.
 */
const campaignSeriesQuerySchema = z
  .object({
    from: z.string().refine((value) => parseSeriesInstant(value) !== null, {
      message: 'must be an ISO-8601 date (2026-08-17) or date-time with a zone (2026-08-17T09:00:00Z)',
    }),
    to: z.string().refine((value) => parseSeriesInstant(value) !== null, {
      message: 'must be an ISO-8601 date (2026-08-17) or date-time with a zone (2026-08-17T09:00:00Z)',
    }),
    bucket: z.enum(CAMPAIGN_SERIES_BUCKETS).optional(),
  })
  .superRefine((query, ctx) => {
    const from = parseSeriesInstant(query.from);
    const to = parseSeriesInstant(query.to);
    // Unparseable bounds have already been reported per field; adding a range
    // issue on top would be a second complaint about the same typo.
    if (!from || !to) return;

    if (from.getTime() >= to.getTime()) {
      // Equality is refused too, unlike on the inclusive-`to` list routes: a
      // half-open window of zero width has no buckets and no honest answer, and
      // an empty `buckets: []` on a chart reads as a fact about the campaign
      // rather than about the request.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: '`from` must be earlier than `to` (the window is half-open)',
      });
      return;
    }
    if (to.getTime() - from.getTime() > CAMPAIGN_SERIES_MAX_WINDOW_DAYS * MS_PER_DAY) {
      // The cap NAMES itself, as the agent series cap does: a caller who wants more needs
      // to know to page by quarter rather than to discover an empty answer.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: `the window must be at most ${CAMPAIGN_SERIES_MAX_WINDOW_DAYS} days — request a narrower range`,
      });
    }
  });

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignStatsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The one route on this plugin that is NOT a plain pass-through.
   *
   * The internal handler's stats payload declares `agents[].agent_name` and
   * leaves it unfilled: it reads the dialer tables, and an agent's display name
   * is a user-directory fact. This route fills it.
   *
   * `enrichAgencyCampaignStats` is a spread over the handler's body, never a
   * reconstruction, so everything else — including fields the handler adds
   * later — arrives byte-identical. It also never throws: a failed lookup
   * degrades the enrichment, because the console polls this every 5 seconds.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/stats', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/stats`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    const body = await enrichAgencyCampaignStats(result.body, {
      tenantId: request.tenantId!,
      status: result.status,
      // `agents[].agent_name` is the only enrichment. `agents_peak` has no producer
      // and stays unserved (see `agency-campaign-wire.ts`).
    });
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/campaigns/:id/stats/series — the campaign's own trend.
   *
   * A plain pass-through of the internal handler's bucketed series:
   * `{ campaign_id, bucket, timezone, buckets: [{ bucket_start, attempts,
   * connected, successes, talk_seconds, wrapup_seconds }] }`. See
   * {@link AgencyCampaignStatsSeries} for what each member means and, more
   * importantly, for the two things this route must NOT do to it — normalise
   * `bucket_start` (a `YYYY-MM-DD` calendar day, not an instant) and add rates.
   *
   * ── The floor is `agency.supervise`, and the sibling above is not ──────────
   * `GET /campaigns/:id/stats` next door floors at `agency.campaigns.read`
   * (`viewer`, 10) — deliberately, and a test pins that boundary against
   * exactly the "tidy up and make them match" change this route looks like an
   * argument for. So the difference has to be stated rather than inferred:
   *
   *  - the live strip is a DASHBOARD. It answers "is this campaign dialling right
   *    now", which is the question an `operator` running the floor has to be able
   *    to ask, and a `viewer` may watch;
   *  - the series is a supervisory REVIEW surface. It is a per-day record of a
   *    campaign's throughput over up to a quarter, and it lives on the same tab
   *    as the roster and the attempt spine — every one of which floors at
   *    `agency.supervise` (`account_admin`, 30). Reading it beside them at a
   *    lower floor would make the tab's own gate a function of which panel had
   *    loaded.
   *
   * `agency.supervise` already exists and already carries this meaning, so there
   * is no new permission: a second gate to keep aligned is a second gate to
   * drift (the same reasoning that declined a new permission for the activity
   * trail). The floor is asserted twice — from the
   * source in `proxy-agency-campaigns.routes.test.ts`, and **by execution** in
   * `proxy-agency-campaign-series.routes.test.ts`, because a source-text table
   * cannot see a `requirePermission` that was deleted along with its own row.
   *
   * ── The `:id` here is not the escape hatch it looks like ──────────────────
   * This route interpolates `:id` in the MIDDLE of the handler path, so it cannot
   * be lengthened into another collection. The direction that matters is the
   * other one: `GET /campaigns/:id` is floored at `viewer` and interpolates its
   * `:id` LAST, so `:id = c%2Fstats%2Fseries` would reach this read two role
   * levels below its own floor. That is closed by the plugin-level
   * `rejectPathEscapingParams()` hook above, not by anything on this route —
   * which is precisely the escalation `helpers/path-params.ts` documents, now
   * with one more route on the high side of it.
   *
   * ── This route validates the window; the internal handler is the authority ─
   * See {@link CAMPAIGN_SERIES_MAX_WINDOW_DAYS} and {@link parseSeriesInstant}
   * for why this layer carries a copy of the handler's rules and why it must
   * never be the stricter of the two, and {@link resolveSeriesQuery} for the two
   * ways it would otherwise be stricter.
   *
   * ── A 404 here ────────────────────────────────────────────────────────────
   * The internal handler's own refusal, `{ code: 'campaign_not_found' }`: the
   * campaign is in another tenant or does not exist. `errorMaskHook` passes every
   * 4xx through untouched (it masks only 5xx bodies), so the body arrives intact,
   * and the hook never rewrites `reply.statusCode` in any case.
   *
   * The client contract on this route is still the STATUS, not a code: any 404 means
   * "there is no series to draw", and the console hides the panel rather than
   * rendering an error.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/stats/series', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Refused before `callCore`, so the 400 is ours and not masked as a handler
    // error, and so an unknown param is a signal rather than a silent drop.
    // Used for THAT gate only — the values it resolves are discarded below.
    const forwarded = forwardAllowedQuery(request.query, CAMPAIGN_SERIES_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    // Read the internal handler's way, not `forwardAllowedQuery`'s: it joins a
    // repeated param with a comma (right for the spine's multi-value filters,
    // wrong for these three) and forwards a padded value untrimmed, and either one
    // would make this route refuse a request the handler answers.
    // `resolveSeriesQuery` mirrors the handler's `singleParam` — first of a
    // repeat, trimmed, blank means absent — and its docstring carries the two
    // cases and why this layer may not be stricter.
    const query = resolveSeriesQuery(request.query);

    // Validated against the RESOLVED query rather than `request.query`, so the
    // string the schema measures is the string the handler will re-read.
    const parsed = parseOr400(campaignSeriesQuerySchema, query, reply, 'agency');
    if (!parsed) return reply;

    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/stats/series`,
      // The resolved params, NOT `parsed.data`: this route validated them and has
      // no opinion about them. In particular `bucket` is forwarded absent when the
      // caller omitted it, so `day` stays the HANDLER's default and is echoed on the
      // response — injecting it here would be a second declaration of the
      // default, and the one that drifts is the one no query exercises.
      query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    // Unchanged, and deliberately NOT through `enrichAgencyCampaignStats`: this
    // layer adds nothing to this payload. There is no agent row to name and no
    // stall to diagnose — a series is a record of what happened, not a live
    // diagnosis — so the enrichment would be a database read per poll that adds no
    // field. A handler error reaches the error mask exactly as the handler wrote it.
    return reply.code(result.status).send(result.body);
  });
}
