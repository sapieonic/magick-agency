/**
 * ─── AGENCY DIALER — THE CAMPAIGN'S TREND LINE, PARSED ──────────────────────
 *
 * Everything `GET /api/v1/agency-campaigns/:id/stats/series` needs that is
 * neither SQL nor a Fastify handler, which is exactly one thing: the query
 * parser.
 *
 * A near-leaf module, and it is deliberately thin. Every VALUE and every leaf
 * RULE it applies is imported rather than restated:
 *
 *   * `AGENT_STATS_BUCKETS` — the `day|week|month` vocabulary, and its inverted
 *     `Record<TUnion, true>` check. Named after the route it was written for and
 *     reused here rather than copied, because a fourth bucket unit added to
 *     `AgencyStatsBucketUnit` must appear on every read that accepts one; a local
 *     copy is how one surface comes to 400 a unit its neighbour serves.
 *   * `ROSTER_MAX_WINDOW_DAYS` (92) — the cap, for the reason
 *     `parseGroupedStatsQuery` gives for reusing it rather than declaring a
 *     second 92: the cost argument is the same one, and two constants holding one
 *     number is a divergence waiting for someone to tune one of them.
 *   * `parseFilterDate` / `singleParam` — the date and single-value rules, so
 *     this surface cannot end up with a second opinion about what an ISO date is.
 *
 * What it owns is the ASSEMBLY — and the assembly is NOT single-definition, which
 * is worth stating plainly because the parser below reads like a shared helper and
 * is not one. `parseCampaignSeriesQuery`'s body is a near-verbatim second copy of
 * `parseAgentStatsQuery`'s (`agent-record.ts`): the two required-parameter pushes,
 * the `from >= to` refusal, the `else if` cap comparison against `MS_PER_DAY`
 * (declared here as well as there) and the bucket-enum check are the same code in
 * the same order, down to the message strings ("`from` must be earlier than `to`
 * (the window is half-open)", "the window must be at most N days — request a
 * narrower range", "unknown bucket: X — expected one of …") and down to reporting
 * the window refusal on `param: 'from'`.
 *
 * The copies differ in exactly two ways, and those two are what buy the file: the
 * cap is `ROSTER_MAX_WINDOW_DAYS` (92) rather than `AGENT_STATS_MAX_WINDOW_DAYS`
 * (366), and `?campaign_id=` is accepted there and refused here.
 *
 * So the duplication is deliberate and it is a MAINTENANCE OBLIGATION, recorded
 * here rather than discovered: a change to what an accepted window or an accepted
 * bucket means — or to any of those strings, which a console may special-case —
 * has to be made in both files. What genuinely cannot drift is the imported half
 * above; the identical wording of the refusals is a convention held by hand.
 *
 * It exists apart from the route so the rules can be exercised without a Fastify
 * instance, and apart from `agent-record.ts` because that module is the AGENT's
 * record — a campaign parser living inside it would be findable only by someone
 * who already knew where to look.
 */

import type { AgencyStatsBucketUnit } from '@magick-agency/contracts/agency';
import { AGENT_STATS_BUCKETS, ROSTER_MAX_WINDOW_DAYS } from './agent-record.js';
import {
  parseFilterDate,
  singleParam,
  type FilterIssue,
  type FilterParse,
} from './spine-filters.js';

const MS_PER_DAY = 86_400_000;

/** The window and grouping one campaign-series read runs over. */
export interface CampaignSeriesParams {
  /** Inclusive lower bound on `dialed_at`. */
  from: Date;
  /** EXCLUSIVE upper bound — see {@link parseCampaignSeriesQuery}. */
  to: Date;
  bucket: AgencyStatsBucketUnit;
}

/**
 * `?from=&to=&bucket=` → {@link CampaignSeriesParams}, or the issues.
 *
 * ── `from` and `to` are REQUIRED ────────────────────────────────────────────
 *
 * Same rule, same reason, as `parseAgentStatsQuery`: the attempt and contact
 * spines can default their window because a keyset page bounds them anyway, and
 * this endpoint has no page — it aggregates, so an absent bound would mean "every
 * day this campaign has ever run, in one payload", and the caller could not tell
 * from the response which window they got.
 *
 * ── `to` is EXCLUSIVE, and that is the half-open convention ─────────────────
 *
 * `[from, to)` is the only shape that tiles: `[Mon, Tue)` and `[Tue, Wed)` cover
 * Tuesday exactly once, so two requests can be concatenated with no day counted
 * twice. Note this DIFFERS from the attempt spine's `to`, which is inclusive
 * (`created_at <= $n`) — right for a "show me up to here" filter, wrong for an
 * aggregate somebody will add up. The two live on adjacent routes and the
 * difference is invisible in a URL, which is why it is stated on both.
 *
 * Equality is refused along with inversion: a half-open window of zero width
 * contains no buckets, and a zero-bucket series would be indistinguishable from a
 * campaign that never dialled.
 *
 * ── The cap is 92 days, NOT the per-agent record's 366 ──────────────────────
 *
 * `ROSTER_MAX_WINDOW_DAYS`, imported. 366 is argued on `AGENT_STATS_MAX_WINDOW_DAYS`
 * from payload size for a read bounded to ONE `agent_user_id`; the argument does
 * not transfer, and the reason it does not is specific to THIS read rather than to
 * the roster's: 92 days at `bucket=day` is 92 or 93 rows out of `generate_series`
 * for every campaign, and the zero-fill means the row count is the WINDOW WIDTH
 * rather than the volume — a campaign that dialled on three days still pays for
 * every bucket in the range. A year of daily buckets is ~367 rows of mostly zeros
 * on a screen that shows a quarter at most. 92 days is a quarter, and it covers
 * every period the console offers.
 *
 * ── 92 days admits 93 buckets, and 93 is the ordinary case ──────────────────
 *
 * The cap is ELAPSED MILLISECONDS (`to - from <= 92 * MS_PER_DAY`); the buckets are
 * CALENDAR days truncated in the campaign's own zone. A window that does not start
 * at local midnight in that zone therefore straddles 93 calendar days, and the
 * spine emits one row for each: `from = 2026-05-11T06:30:00Z` with
 * `default_timezone = 'Asia/Kolkata'` (12:00 local) plus exactly 92 days yields 93
 * `bucket_start` rows — verified by execution, not derived. Only a `from` that
 * lands on local midnight gives 92. The first and last of those buckets are also
 * PARTIAL, which is the caller-visible half of the same fact and is documented on
 * {@link AgencyCampaignStatsSeries.buckets}.
 *
 * Nothing is capped, clipped or renumbered to make it 92 — the alternatives are
 * dropping a bucket that contains real dials or moving the window's edges away
 * from what the caller asked for. It is stated here so a payload-size argument is
 * made against the number the endpoint can actually return.
 *
 * The refusal NAMES the bound, in the same words as the roster's, so a caller
 * wanting a year learns to page by quarter rather than discovering an empty
 * answer.
 *
 * ── `?campaign_id=` is deliberately NOT accepted ────────────────────────────
 *
 * The path fixes the campaign, so a query parameter for it can only agree with
 * `:id` or be wrong — the same reason `AgencyAttemptFilters` has no `campaignId`
 * on the campaign-scoped spine while the agent-scoped one does. It is not
 * silently ignored either: master applies an unknown-query-parameter check, so it
 * arrives as a 400 naming the parameter rather than as a URL that reads as one
 * question and is answered as another.
 *
 * There is also no `tz`. Buckets are cut in the CAMPAIGN's own
 * `default_timezone` — the same zone its calling window is enforced in — and the
 * zone is echoed on the response. See {@link AgencyCampaignStatsSeries.timezone}.
 */
export function parseCampaignSeriesQuery(
  query: Record<string, unknown>,
): FilterParse<CampaignSeriesParams> {
  const issues: FilterIssue[] = [];

  const fromRaw = singleParam(query['from']);
  const toRaw = singleParam(query['to']);
  if (fromRaw === undefined) issues.push({ param: 'from', message: 'is required' });
  if (toRaw === undefined) issues.push({ param: 'to', message: 'is required' });
  const from = parseFilterDate('from', fromRaw, issues);
  const to = parseFilterDate('to', toRaw, issues);

  // Refused rather than silently emptied, exactly as `parseAgentStatsQuery` and
  // `parseRosterQuery` do: an empty series reads as a fact about the campaign
  // rather than about the request.
  if (from && to && from.getTime() >= to.getTime()) {
    issues.push({ param: 'from', message: '`from` must be earlier than `to` (the window is half-open)' });
  } else if (from && to && to.getTime() - from.getTime() > ROSTER_MAX_WINDOW_DAYS * MS_PER_DAY) {
    // The same constant, the same message text and the same `param: 'from'` as the
    // roster's refusal — one bound, one wording, so a console that special-cases
    // the string does not have to learn a second one.
    issues.push({
      param: 'from',
      message: `the window must be at most ${ROSTER_MAX_WINDOW_DAYS} days — request a narrower range`,
    });
  }

  // Defaulted rather than required: `day` is what a trend line opens on, and
  // unlike the window there is no way to be wrong about which grouping you got —
  // it is echoed on the response.
  const bucketRaw = singleParam(query['bucket']);
  let bucket: AgencyStatsBucketUnit = 'day';
  if (bucketRaw !== undefined) {
    if (!(AGENT_STATS_BUCKETS as readonly string[]).includes(bucketRaw)) {
      // The valid set is echoed, as every other refusal on this surface does: a
      // client holding a stale vocabulary recovers in one round trip instead of
      // guessing.
      issues.push({
        param: 'bucket',
        message: `unknown bucket: ${bucketRaw} — expected one of ${AGENT_STATS_BUCKETS.join(', ')}`,
      });
    } else {
      bucket = bucketRaw as AgencyStatsBucketUnit;
    }
  }

  if (issues.length > 0 || !from || !to) {
    // `!from || !to` cannot be reached with an empty issue list — both are
    // required above — but the compiler cannot see that, and returning `ok: true`
    // with a fabricated window would be the worse way to satisfy it.
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }] };
  }

  return { ok: true, filters: { from, to, bucket } };
}
