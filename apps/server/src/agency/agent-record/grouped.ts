/**
 * The grouped read (`GET /api/v1/agency-agents/grouped-stats`): its dimensions,
 * zone rule and query parsing. Split out of `agent-record.ts`, which re-exports
 * everything here — import from that path.
 */
import type {
  AgencyGroupDimension,
  AgencyGroupSort,
} from '@magick-agency/contracts/agency';
import {
  parseCampaignIdParam,
  parseRequiredWindow,
  singleEnum,
  singleParam,
  validateEnum,
  vocabulary,
  type FilterIssue,
} from '../spine-filters.js';
import { ROSTER_MAX_WINDOW_DAYS, ROSTER_ORDERS, ROSTER_SORTS } from './roster.js';

// ─── THE GROUPED READ (`GET /api/v1/agency-agents/grouped-stats`) ────────────
//
// The same window, the same scope and the same five metric expressions as the
// roster, grouped by one or two CALLER-CHOSEN dimensions instead of by agent. So
// everything in `stats.ts` and `roster.ts` about how a window is parsed and refused
// applies unchanged, and
// the cap is literally the same constant.
//
// What is new, and it is the whole reason this parsing is here rather than in the
// route, is that the choice of dimension can make the read UNANSWERABLE — a time
// bucket across campaigns in different zones is not one column (see
// {@link parseGroupedStatsQuery}). That is a product rule, so it has to be
// exercisable without a Fastify instance and without a pool.

/**
 * The group vocabulary, as the inverted `Record` check — and its DECLARATION
 * ORDER is the canonical order.
 *
 * Two jobs, and the second is why the order matters: it guards the 400 that names
 * the valid set (same argument as {@link ROSTER_SORTS}), and `vocabulary()` reads
 * the keys back in declaration order, which is the order `group_by` is echoed in
 * and the order the key's dimensions are compared in. So `agent,campaign` and
 * `campaign,agent` canonicalise to the same list, are the same read, and cache the
 * same — rather than being two spellings that return the same rows in two orders.
 */
export const AGENCY_GROUP_DIMENSIONS = vocabulary<AgencyGroupDimension>({
  agent: true, campaign: true, disposition: true,
  day: true, day_of_week: true, hour_of_day: true,
});

/** What a grouped read may be ordered by. Same inverted-`Record` argument. */
export const GROUP_SORTS = vocabulary<AgencyGroupSort>({
  key: true, attempts: true, connected: true, successes: true,
  connect_rate_pct: true, success_rate_pct: true, aht_seconds: true,
});

/**
 * **Two dimensions, and it is a BOUND rather than a preference.**
 *
 * The row count is the PRODUCT of the grouped dimensions' cardinalities, so a
 * third dimension turns a bounded read into an unbounded one: agent × campaign ×
 * hour on a floor of 30 across 8 campaigns is 5,760 potential groups before a
 * fourth is even considered. Against that, every screen in scope needs at most two
 * — `agent`+`campaign` for contribution, `day_of_week`+`hour_of_day` for best
 * hours, `agent`+`day` for a trend. A third dimension is unbounded cost for no
 * named screen.
 */
export const GROUP_MAX_DIMENSIONS = 2;

/**
 * `key` ascending — and unlike the roster's `successes desc`, this default is
 * about READABILITY rather than about the opening question.
 *
 * A grouped read is most often a series (`hour_of_day`) or a matrix
 * (`agent`×`campaign`), and key order is the only order in which either reads
 * correctly: an hour-of-day series sorted by `successes` is not a series, it is a
 * league table whose x-axis has been shuffled. A metric sort is for the
 * contribution question, which the caller asks for explicitly.
 */
export const GROUP_DEFAULT_SORT: AgencyGroupSort = 'key';
export const GROUP_DEFAULT_ORDER = 'asc' as const;

/**
 * Page size. **Both bounds refuse rather than clamp**, same rule and same reason
 * as {@link ROSTER_MAX_LIMIT}.
 *
 * Higher than the roster's 200 because the row count here is a product rather
 * than a headcount: a `day`×`agent` matrix over a month on a floor of 30 is ~900
 * legitimate groups, and a ceiling below that would make a real screen
 * unrenderable. Still a ceiling, because `limit` is the ONLY bound on the response
 * size this read has — there is no cursor, and the window cap bounds cost rather
 * than cardinality.
 */
export const GROUP_DEFAULT_LIMIT = 200;
export const GROUP_MAX_LIMIT = 1000;

/**
 * Which dimensions are cut in a TIMEZONE, as the inverted `Record` rather than a
 * `['day', 'day_of_week', 'hour_of_day']` array.
 *
 * The same argument as every other vocabulary here, and it bites hardest on this
 * one: a seventh dimension added to {@link AgencyGroupDimension} is a missing
 * required key, i.e. a build error that forces a decision about whether it needs a
 * zone. An array would compile, and a new time dimension would then skip the
 * ambiguity refusal below entirely and silently bucket across zones — which is the
 * exact failure that refusal exists to prevent.
 */
const GROUP_DIMENSION_NEEDS_ZONE: Record<AgencyGroupDimension, boolean> = {
  agent: false, campaign: false, disposition: false,
  day: true, day_of_week: true, hour_of_day: true,
};

/**
 * Whether a grouping is cut in a timezone at all — the ONE `some` that both the zone rule's
 * refusal and `AgencyGroupPage.resolved_timezone` read.
 *
 * Shared rather than spelled at each site because the two rules have to agree: if
 * the refusal quantified over `some` while the zone field decided on `every`, a
 * page could be bucketed in a zone it then declined to name, or name a zone it
 * never cut anything in. One function over {@link GROUP_DIMENSION_NEEDS_ZONE}
 * makes that agreement structural instead of a claim two conditions keep making
 * separately — and a seventh dimension is still a missing required key on the
 * record, i.e. a build error that forces the decision.
 *
 * `some`, not `every`, and the two differ on exactly one shape: a pair holding one
 * zoned dimension beside a non-zoned one (`agent,day`). That page IS cut in a zone
 * — the zoned half needs one — so `every` would wave it through the refusal AND
 * report no zone for it. `agent-record.test.ts` asserts both halves.
 */
export function groupByIsZoned(groupBy: readonly AgencyGroupDimension[]): boolean {
  return groupBy.some((dimension) => GROUP_DIMENSION_NEEDS_ZONE[dimension]);
}

/**
 * The refusals this route answers with a `code`, beyond the generic validation
 * 400.
 *
 * Both are cases where the request is well-formed — every value is in its
 * vocabulary — and still cannot be answered, so a client needs to tell them apart
 * from a typo without parsing prose. `details` still carries the human message.
 */
export type AgencyGroupRefusal = 'too_many_dimensions' | 'timezone_ambiguous';

/** A {@link FilterIssue} that may carry one of those codes. */
export interface AgencyGroupIssue extends FilterIssue {
  code?: AgencyGroupRefusal;
}

export type AgencyGroupParse =
  | { ok: true; filters: AgentGroupedParams }
  | { ok: false; issues: AgencyGroupIssue[] };

/** The window, filters, grouping and ranking one grouped read runs over. */
export interface AgentGroupedParams {
  /** Inclusive lower bound on `dialed_at`. */
  from: Date;
  /** EXCLUSIVE upper bound, same half-open window as {@link AgentRosterParams}. */
  to: Date;
  /** Narrow every row to one campaign; also one of the two zone-rule remedies. */
  campaignId?: string;
  /**
   * 1..{@link GROUP_MAX_DIMENSIONS} dimensions, deduplicated and in the CANONICAL
   * order of {@link AGENCY_GROUP_DIMENSIONS} — never the order the request used.
   */
  groupBy: AgencyGroupDimension[];
  sort: AgencyGroupSort;
  order: 'asc' | 'desc';
  limit: number;
}

/**
 * Whether a grouped read has ONE zone for the WHOLE page — the predicate behind
 * `AgencyGroupPage.resolved_timezone`.
 *
 * True iff a zoned dimension is grouped AND the read is filtered to one campaign.
 * **Both halves, and the second is the one that is easy to lose.** The zone rule accepts a
 * time dimension on EITHER of two remedies and only one of them narrows the read
 * to a single zone: `group_by=campaign,hour_of_day` with no `campaign_id` is a
 * legal 200 spanning every campaign in the account — that remedy is the one the zone rule's
 * refusal message names FIRST, `campaign` plus one time dimension fits
 * {@link GROUP_MAX_DIMENSIONS} exactly, and each row is correctly cut in its own
 * campaign's zone. `agency_campaigns.default_timezone` is per campaign
 * (`VARCHAR(64) NOT NULL DEFAULT 'UTC'`) with no account-level
 * uniqueness, so those zones genuinely differ. N zones, no page-level label,
 * `null`.
 *
 * Dropping the `campaignId` half therefore does not merely widen the field: it
 * makes the page name ONE of several zones as though the whole matrix were cut in
 * it, which is the confidently-wrong hour axis the field exists to prevent.
 *
 * "Exactly one campaign" reduces to "a `campaign_id` is present" because the
 * house-wide `singleParam` takes `raw[0]`, so this surface accepts at most one.
 *
 * Pure, and here rather than in the repository, for this section's stated reason:
 * which questions this read can answer is a product rule, so it has to be
 * exercisable without a pool and without a Fastify instance.
 */
export function groupedPageHasSingleZone(
  p: Pick<AgentGroupedParams, 'groupBy' | 'campaignId'>,
): boolean {
  return p.campaignId !== undefined && groupByIsZoned(p.groupBy);
}

/**
 * `?from=&to=&campaign_id=&group_by=&sort=&order=&limit=` → {@link AgentGroupedParams}.
 *
 * ── The window rules and the CAP are both imported ──────────────────────────
 *
 * Required, half-open, `parseFilterDate`, and capped at
 * {@link ROSTER_MAX_WINDOW_DAYS} — the roster's own constant, deliberately reused
 * rather than a second 92 declared here. The cost argument is the same one, and
 * stronger: this read has no `LIMIT`-free requirement so the page IS bounded, but
 * the SCAN is not — the window is still the only thing bounding how many attempt
 * rows are aggregated, and the server sets no `statement_timeout` anywhere. Two caps
 * holding the same value would be two things to change and one of them would be
 * missed.
 *
 * ── `group_by` is REQUIRED, and 1 or 2 entries ───────────────────────────────
 *
 * Not defaulted. A grouped read with no grouping is the roster (by agent) or a
 * single-row total, and both of those already have routes; defaulting would make
 * the same URL mean a different question depending on which build answered it.
 *
 * The COMMA form is the request form: `?group_by=agent,campaign`. The REPEATED
 * form (`?group_by=agent&group_by=campaign`) arrives as an array and
 * {@link singleParam} takes `raw[0]`, so the second value is dropped before it is
 * seen — house-wide behaviour on every single-valued param on this surface, not
 * something introduced here, and not reachable from the browser because the public
 * API layer's `forwardAllowedQuery` comma-JOINS a repeated param into exactly the
 * form above. The applied `group_by` is echoed on the response either way, so a
 * direct caller of the internal handler can always see what it got.
 *
 * A duplicate (`agent,agent`) refuses rather than deduplicating silently: it
 * halves the dimensionality of the answer, and a caller who wrote it meant
 * something else.
 *
 * ── A TIME DIMENSION NEEDS AN UNAMBIGUOUS ZONE, OR THE READ IS REFUSED ───────
 *
 * This is the rule most likely to be read as over-strict, so it is derived here
 * rather than asserted. Buckets are cut in the CAMPAIGN's own `default_timezone`
 * (see `AgencyAgentStatsRepository.attemptBuckets` for the resolution apparatus
 * and for why the `pg_timezone_names` LEFT JOIN is load-bearing). So when a time
 * dimension is grouped across campaigns in different zones, "the 18:00 row" is not
 * one thing — it is several local 18:00s summed into one number that describes no
 * hour anywhere.
 *
 * The zone is unambiguous when EITHER `campaign` is also grouped (each row then
 * carries its own campaign's zone, and every attempt still lands in exactly one
 * bucket) OR exactly one `campaign_id` is filtered (one zone for the whole read).
 * Otherwise this refuses with `timezone_ambiguous`, naming BOTH remedies — a
 * refusal that names one remedy trains a caller to always use that one.
 *
 * **There is deliberately no implicit UTC fallback and no `tz` parameter here.** A
 * silent UTC bucketing of an account whose campaigns run in `Asia/Kolkata` puts the
 * real 18:00 connect peak in the 12:00 column, and the only visible symptom is a
 * rostering decision that is quietly wrong — which is the exact failure a
 * best-hours screen exists to prevent. Neither named consumer screen is affected:
 * best hours is per campaign, and contribution groups by campaign. A `tz` parameter
 * stays additive for later; adding surface now, for no named screen, buys a second
 * behaviour to keep correct.
 *
 * ── `sort`/`order`/`limit`, same rules as the roster ────────────────────────
 *
 * Defaulted when absent (both are echoed, so a caller can always tell what they
 * got) and REFUSED when unknown (a client holding a stale vocabulary must be told,
 * not handed a differently-ordered page that looks like an answer). `limit`
 * refuses outside 1..{@link GROUP_MAX_LIMIT} rather than clamping, because this
 * list has no cursor and a silently changed limit changes WHICH groups are on the
 * page.
 */
export function parseGroupedStatsQuery(query: Record<string, unknown>): AgencyGroupParse {
  const issues: AgencyGroupIssue[] = [];

  // Refused rather than silently emptied, and capped on the ROSTER's constant —
  // see the docstring for why that is a reuse and not a coincidence.
  const { from, to } = parseRequiredWindow(query, ROSTER_MAX_WINDOW_DAYS, issues);
  const campaignId = parseCampaignIdParam(query, issues);

  const groupBy = parseGroupBy(singleParam(query['group_by']), issues);

  // The zone-rule refusal. Checked only once `group_by` itself parsed: reporting an
  // ambiguous zone for a dimension the caller misspelled would name the wrong
  // problem, and the misspelling is already an issue on the list.
  if (groupBy.length > 0
    && groupByIsZoned(groupBy)
    && !groupBy.includes('campaign')
    && campaignId === undefined) {
    issues.push({
      param: 'group_by',
      code: 'timezone_ambiguous',
      message: 'a time dimension (day, day_of_week, hour_of_day) is cut in the campaign\'s own '
        + 'timezone, so it is only unambiguous when campaigns are separated: either add '
        + '`campaign` to `group_by`, or filter to exactly one `campaign_id`',
    });
  }

  const sort = singleEnum('sort', singleParam(query['sort']), GROUP_SORTS, issues);
  const order = singleEnum('order', singleParam(query['order']), ROSTER_ORDERS, issues);

  // Parsed through the raw string rather than `Number()` alone, for the reasons
  // `parseRosterQuery` states: `Number('1.5')` is finite and would floor to 1, and
  // `Number('')` is 0 — so a cleared form field would refuse naming a bound the
  // caller never typed.
  const limitRaw = singleParam(query['limit']);
  let limit = GROUP_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(parsed)
      || parsed < 1 || parsed > GROUP_MAX_LIMIT) {
      issues.push({
        param: 'limit',
        message: `must be a whole number between 1 and ${GROUP_MAX_LIMIT}`,
      });
    } else {
      limit = parsed;
    }
  }

  if (issues.length > 0 || !from || !to || groupBy.length === 0) {
    // The three guards after the length check cannot be reached with an empty issue
    // list — all three are required above — but the compiler cannot see that, and
    // returning `ok: true` with a fabricated window or an empty grouping would be
    // the worse way to satisfy it.
    return {
      ok: false,
      issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }],
    };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      ...(campaignId ? { campaignId } : {}),
      groupBy,
      sort: sort ?? GROUP_DEFAULT_SORT,
      order: order ?? GROUP_DEFAULT_ORDER,
      limit,
    },
  };
}

/**
 * `group_by` → the canonical, deduplicated dimension list, or `[]` plus issues.
 *
 * Split out so the three separate refusals — too many, unknown, repeated — are
 * readable as three rules rather than as one nested condition, and so the
 * canonicalisation happens in exactly one place.
 *
 * The count is checked BEFORE the vocabulary: `?group_by=a,b,c,d` with four typos
 * should be told it asked for too many dimensions, not handed four unknown-value
 * messages that all become moot once it drops two of them.
 */
function parseGroupBy(raw: string | undefined, issues: AgencyGroupIssue[]): AgencyGroupDimension[] {
  if (raw === undefined) {
    issues.push({
      param: 'group_by',
      message: `is required — expected one or two of ${AGENCY_GROUP_DIMENSIONS.join(', ')}`,
    });
    return [];
  }

  // Blank entries dropped rather than refused: `?group_by=agent,` is what string
  // concatenation in a client produces, and it plainly means one dimension.
  // `singleParam` has already turned an entirely blank value into `undefined`.
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    issues.push({
      param: 'group_by',
      message: `is required — expected one or two of ${AGENCY_GROUP_DIMENSIONS.join(', ')}`,
    });
    return [];
  }
  if (entries.length > GROUP_MAX_DIMENSIONS) {
    issues.push({
      param: 'group_by',
      code: 'too_many_dimensions',
      message: `at most ${GROUP_MAX_DIMENSIONS} dimensions — the row count is the product of `
        + `their cardinalities, so a third makes the response unbounded; got ${entries.length}`,
    });
    return [];
  }

  const validated = validateEnum<AgencyGroupDimension>(
    'group_by', entries, AGENCY_GROUP_DIMENSIONS, issues,
  );
  if (!validated) return [];

  const unique = new Set(validated);
  if (unique.size !== validated.length) {
    // Refused rather than deduplicated: grouping by one dimension twice halves the
    // dimensionality of the answer, so a caller who wrote it meant something else
    // and silently answering the narrower question is the worse outcome.
    issues.push({ param: 'group_by', message: 'must not repeat a dimension' });
    return [];
  }

  // CANONICALISED here and nowhere else. Filtering the vocabulary rather than
  // sorting the input is what makes "canonical order" mean the declaration order
  // by construction instead of by a comparator that could disagree with it.
  return AGENCY_GROUP_DIMENSIONS.filter((dimension) => unique.has(dimension));
}
