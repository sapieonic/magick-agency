/*
 * The live stats strip (with its best-effort health dependencies) and the stats series.
 * Part of `agency-campaigns.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import type { AgencyCampaignStats, AgencyCampaignStatsSeries } from '@magick-agency/contracts/agency';
// The trend line's query parser. Its own module, and a thin one: the bucket
// vocabulary, the 92-day cap and the date rules are all imported there rather
// than re-declared.
import { parseCampaignSeriesQuery } from '../../../agency/campaign-series.js';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { campaignHealth, RECENT_FAILURE_WINDOW_MINUTES } from '../../../agency/campaign-health.js';
import { resolveCallingWindow, callingWindowState, nextWindowOpen } from '../../../agency/calling-hours.js';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
import type { AgencyCampaignRouteDeps } from '../agency-campaigns.routes.js';
import { campaignOf, ownedCampaign } from './guards.js';

const log = createChildLogger({ component: 'agency-campaign-routes' });

/**
 * Run one strip dependency as GENUINELY best-effort.
 *
 * `.catch()` on its own only handles a *rejected* promise. A **synchronous** throw
 * while `Promise.all`'s array literal is being built — a missing `deps` (Fastify
 * passes the register options object as the second argument when a plugin is
 * registered without a wrapper closure), a getter that throws, a non-function
 * `appliedVersion` — escapes before any promise exists, so no `.catch()` is ever
 * attached and the whole route 500s. That is the one failure mode the strip's
 * best-effort contract exists to survive.
 *
 * Invoking the read INSIDE the chain lands both failure shapes on the same
 * fallback. Degraded still means a 200 with a `null`/`0` field the assembler has a
 * defined branch for — never a 500, and never a silent one either: the warn is the
 * only place a wiring mistake becomes visible, since the response looks merely
 * degraded.
 */
function bestEffort<T>(dependency: string, read: () => T | Promise<T>, fallback: T): Promise<T> {
  return Promise.resolve()
    .then(read)
    .catch((err: unknown) => {
      log.warn({ err, dependency }, 'Campaign stats dependency degraded — serving fallback');
      return fallback;
    });
}

/**
 * Which pending contacts are shut out of their calling window right now.
 *
 * Evaluates the REAL rule (`callingWindowState`) once per distinct timezone
 * rather than re-expressing it in SQL. A roster has a handful of distinct
 * timezones however many contacts it holds, so this is exact and cheap where a
 * per-row evaluation would not be, and — more importantly — there is still only
 * one definition of when a number may be dialled.
 *
 * `unresolvable` counts as shut out: a contact whose timezone cannot be resolved
 * is never dialled by the pre-dial gate either, so counting it as dialable would
 * make the strip claim work is available that the engine will not do.
 */
function evaluateCallingHours(
  campaign: AgencyCampaignRecord,
  pendingByTimezone: Array<{ timezone: string | null; count: number }>,
): { outsideCallingHours: number; nextWindowOpensAt: Date | null } {
  const now = new Date();
  let outside = 0;
  let soonest: Date | null = null;

  for (const group of pendingByTimezone) {
    const window = resolveCallingWindow(campaign, { timezone: group.timezone });
    if (callingWindowState(window, now) === 'open') continue;
    outside += group.count;
    const opens = nextWindowOpen(window, now);
    if (opens && (soonest === null || opens < soonest)) soonest = opens;
  }

  return { outsideCallingHours: outside, nextWindowOpensAt: soonest };
}

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignStatsRoutes(app: FastifyInstance, deps: AgencyCampaignRouteDeps): Promise<void> {
  // ── GET /api/v1/agency-campaigns/:id/stats ───────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/stats', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);
    // Two producers, one payload. The repository half is SQL over this campaign;
    // the health half needs Redis (DNC sync state, the account concurrency
    // counter) and a pure TS rule (calling hours), which is why `stats()` cannot
    // and should not reach it. `AGENCY_STATS_ROUTE_FIELDS` is the split, stated
    // once and imported by both sides.
    const [stats, health] = await Promise.all([
      agencyCampaignRepository.stats(campaign.id),
      agencyCampaignRepository.healthInputs(campaign.id),
    ]);

    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);

    // Every one of these is best-effort by design: the strip exists to explain a
    // stall, so a strip that 500s when a dependency is degraded fails at exactly
    // the moment it is needed. A failed read becomes `null`, and `null` has a
    // defined meaning in every branch of the assembler — never a guess.
    //
    // Each read is wrapped rather than merely `.catch()`-ed, because a `.catch()`
    // hung off an expression cannot catch that expression's own SYNCHRONOUS throw
    // — see `bestEffort`. The fallbacks are unchanged and the difference between
    // them is deliberate: `concurrencyLimit` falls back to `0`, which `saturated()`
    // reads as "no known ceiling" and therefore never diagnoses saturation, while
    // the other two fall back to `null`, which the assembler reads as "unknown".
    const [dncAppliedVersion, concurrencyLimit, concurrencyInUse, connected] = await Promise.all([
      bestEffort<number | null>(
        'agency.dnc.appliedVersion',
        () => deps.runtime.dnc.appliedVersion(tenantId),
        null,
      ),
      bestEffort<number>(
        'account_settings.max_concurrent_calls',
        () => accountSettingsRepository.getMaxConcurrentCalls(tenantId, accountId),
        0,
      ),
      bestEffort<number | null>(
        'concurrency.distributed_account_count',
        () => deps.callManager.accountConcurrencyGuard
          .getDistributedAccountCount(tenantId, accountId)
          .then((r) => (r.status === 'available' ? r.count : null)),
        null,
      ),
      // The floor's liveness column. One `MGET` for the whole floor, and best-effort
      // like every other strip dependency — but note what the fallback MEANS
      // here: an empty map leaves every agent `connected: null` ("unknown"),
      // never `false`. Manufacturing "disconnected" from a degraded Redis read
      // would be a confident wrong answer on the screen a supervisor acts from,
      // which is the same mistake `concurrency_in_use` avoids by falling back to
      // `null` rather than to `0`.
      //
      // In the SAME `Promise.all` as the other three, not awaited after them.
      // Its only input is `stats.agents`, already resolved well above, so there
      // is no ordering reason to serialise it — and this route is polled every
      // few seconds by the supervisor dashboard, so a separate await makes the
      // latency `max(a,b,c) + d` instead of `max(a,b,c,d)`, adding a full extra
      // round trip to every poll under exactly the Redis latency spike
      // `bestEffort` exists to absorb.
      bestEffort<Map<string, boolean>>(
        'agency.stations.connectedBySession',
        () => deps.runtime.stations.connectedBySession(stats.agents.map((a) => a.session_id)),
        new Map(),
      ),
    ]);

    const { outsideCallingHours, nextWindowOpensAt } = evaluateCallingHours(campaign, health.pendingByTimezone);

    // Annotated, not inferred. An un-annotated spread widens to whatever the
    // repository happens to return, so the response could silently omit fields the
    // contract declares required with nothing anywhere objecting. With the
    // annotation, a field NEITHER producer supplies is a compile error at the
    // seam that serves it rather than an `undefined` a consumer reads months later.
    const payload: AgencyCampaignStats = {
      campaign_id: campaign.id,
      status: campaign.status,
      ...stats,
      // Overrides the spread's `agents`, which carries every field EXCEPT this one
      // (`AGENCY_AGENT_ROUTE_FIELDS`). `?? null` is the unknown case — a session
      // missing from the map was never answered for, which is not the same as
      // having been answered `false`.
      agents: stats.agents.map((agent) => ({
        ...agent,
        connected: connected.get(agent.session_id) ?? null,
      })),
      // Contacts remaining and retries pending are genuinely different numbers —
      // `next_attempt_at` can be hours out, so "list exhausted" and "campaign
      // complete" are not the same thing and the dashboard shows both.
      concurrency_limit: concurrencyLimit,
      concurrency_in_use: concurrencyInUse,
      ...campaignHealth({
        campaign,
        stats,
        dncAppliedVersion,
        concurrencyLimit,
        concurrencyInUse,
        contactsOutsideCallingHours: outsideCallingHours,
        nextCallingWindowOpensAt: nextWindowOpensAt,
        nextRetryAt: health.nextRetryAt,
        lastDialAt: health.lastDialAt,
        recentFailures: { ...health.recent, windowMinutes: RECENT_FAILURE_WINDOW_MINUTES },
        onBreakByReason: health.onBreakByReason,
      }),
    };
    return reply.send(payload);
  });

  /**
   * ── GET /api/v1/agency-campaigns/:id/stats/series ─────────────────────────
   *
   * `?from=&to=&bucket=day|week|month`. `from` inclusive, `to` EXCLUSIVE, both
   * required, capped at the same 92 days the agent roster and the grouped read
   * enforce (`ROSTER_MAX_WINDOW_DAYS`, imported — not a second 92).
   *
   * The public API layer serves it at `/proxy/agency/campaigns/:campaignId/stats/series`.
   *
   * ── Why this is a second route and not fields on `/:id/stats` ─────────────
   *
   * `/:id/stats` is the campaign RIGHT NOW: lifetime counters, a live floor, a
   * health strip. It is polled every few seconds by the supervisor dashboard, and
   * it cannot answer "is this getting better or worse" because every counter on it
   * is a single lifetime total — which is why there is no `previous_hour` block
   * (see the note at the end of `AgencyCampaignStats`: a lifetime figure beside one
   * hour of it reads as a permanent collapse). A trend needs its own window
   * parameters, so it needs its own route; bolting a `?from=&to=` onto the live
   * payload would make the poll carry a range aggregate it does not want and make
   * the range read carry a Redis fan-out it does not need.
   *
   * ── ROUTE PRECEDENCE, tested rather than reasoned about ───────────────────
   *
   * This path has one MORE segment than `/:id/stats`, so Fastify's radix tree
   * separates them with no ambiguity. None of that is asserted by the route
   * existing, which is the point: an assertion can pass vacuously against a route
   * that does not exist, and a 404 and a wrong-handler 200 are both invisible to a
   * status-code assertion on the sibling.
   * `test/unit/agency/campaign-stats-series-route.test.ts` pins BOTH directions —
   * `/stats` still reaches the live payload, `/stats/series` reaches the series.
   *
   * ── AUTH AND THE FLAG, and why the plugin is the whole answer ─────────────
   *
   * Auth middleware is registered PER ROUTE PLUGIN, not globally, so a route on a
   * sibling plugin inherits nothing and ships unauthenticated. Being on THIS plugin
   * gives this route the `preHandler` hook, and its `ownedCampaign` preHandler gives it the feature
   * gate and `requireOwned`'s tenant/account scoping. All three are asserted by
   * the route test rather than trusted to this comment.
   *
   * Gated, like every other read here: the flag's other job is to make the feature
   * ABSENT for a tenant who has not bought it, and this changes nothing, so none of
   * the reasoning that ungates `/stop` and `/pause` applies.
   *
   * ── What the payload does and does not carry ──────────────────────────────
   *
   * Every bucket in the range, zeros included — a weekend is `attempts: 0`, never
   * an absent key. No rates: both halves of every rate are on every bucket and the
   * client derives them, because a chart aggregating buckets into one column needs
   * `Σnum / Σden` rather than the mean of the per-bucket rates. The `timezone` is
   * the campaign's own, RESOLVED, and it is echoed so a consumer never has to
   * guess which zone the labels were cut in. All three are argued on
   * `AgencyCampaignStatsSeries`.
   */
  app.get<{ Params: { id: string } }>('/:id/stats/series', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);

    const parsed = parseCampaignSeriesQuery((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return replyValidationFailed(reply, parsed.issues);
    }

    const series: AgencyCampaignStatsSeries | null = await agencyCampaignRepository.statsSeries(
      { tenantId: getTenantId(request), accountId: getAccountId(request) },
      campaign.id,
      parsed.filters,
    );
    // `null` means the campaign matched nothing in scope — which `requireOwned`
    // just checked, so in practice it was deleted between the two reads. 404 is the
    // same answer that check gives, rather than an empty series that would read as
    // "this campaign dialled nobody".
    if (!series) {
      return reply.code(404).send({
        error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found',
      });
    }
    // The window width and the grouping, never the numbers: this is polled from a
    // chart, so the operational signal is the shape of the request.
    log.debug(
      { campaignId: campaign.id, bucket: parsed.filters.bucket, buckets: series.buckets.length },
      'Campaign stats series served',
    );
    return reply.send(series);
  });
}
