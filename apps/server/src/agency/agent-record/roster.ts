/**
 * The supervisor's roster (`GET /api/v1/agency-agents/stats`): its vocabulary,
 * query parsing, percentiles and sort. Split out of `agent-record.ts`, which re-exports
 * everything here — import from that path.
 */
import type {
  AgencyRosterAgentRow,
  AgencyRosterPercentiles,
  AgencyRosterSort,
} from '@magick-agency/contracts/agency';
import {
  parseCampaignIdParam,
  parseRequiredWindow,
  singleEnum,
  singleParam,
  vocabulary,
  type FilterIssue,
  type FilterParse,
} from '../spine-filters.js';
import { AGENT_STATS_BUCKETS, AGENT_STATS_MAX_WINDOW_DAYS } from './stats.js';

// ─── THE SUPERVISOR'S ROSTER (`GET /api/v1/agency-agents/stats`) ─────────────
//
// The same window and the same scope as the per-agent record, grouped ONE LEVEL
// UP: per agent instead of per bucket. So everything in `stats.ts` about how a window is
// parsed applies unchanged, and everything about bucketing does not apply at all —
// there is no bucket on this route, therefore no `bucket` parameter, no
// `date_trunc`, and no campaign timezone to resolve.
//
// What is new is that the roster is RANKED, and ranking is why the three pure
// helpers at the bottom of this section live here rather than in the repository:
// the ordering rule (nulls last in both directions, `agent_user_id` as the
// tiebreaker) and the percentile rule (thin rows excluded) are product decisions
// that must be exercisable without a database, and they are the two rules a
// reader is most likely to assume are "just the default".

/**
 * What the roster may be ordered by, as the inverted `Record` check.
 *
 * Same argument as {@link AGENT_STATS_BUCKETS}, and it bites harder here: a tenth
 * sort key added to {@link AgencyRosterSort} and forgotten in this object is a
 * missing required key, i.e. a build error naming it — where `satisfies` would
 * compile and leave a real, declared sort key answering 400 "unknown sort".
 */
export const ROSTER_SORTS = vocabulary<AgencyRosterSort>({
  attempts: true, connected: true, connect_rate_pct: true, successes: true,
  success_rate_pct: true, aht_seconds: true, talk_seconds: true,
  occupancy_pct: true, agent_user_id: true,
});

/** The two directions. Spelled as a vocabulary so the 400 echoes them like every other. */
export const ROSTER_ORDERS = vocabulary<'asc' | 'desc'>({ asc: true, desc: true });

/**
 * `successes` descending — the roster's opening question, and deliberately not
 * `attempts`.
 *
 * A roster sorted by dial count ranks agents by how hard the DIALER worked them,
 * which is a fact about the pacing engine and the list rather than about them.
 * `successes` is the outcome the floor is run for. It is also a raw count rather
 * than a rate, so the default page cannot be topped by an agent with one connect
 * and one sale.
 */
export const ROSTER_DEFAULT_SORT: AgencyRosterSort = 'successes';
export const ROSTER_DEFAULT_ORDER = 'desc' as const;

/**
 * Page size. **Both bounds refuse rather than clamp** — see {@link parseRosterQuery}.
 *
 * 200 is above any real floor for one account, so the ceiling is a guard against
 * a generated client sending `limit=100000`, not a paging boundary anybody is
 * expected to hit.
 */
export const ROSTER_DEFAULT_LIMIT = 100;
export const ROSTER_MAX_LIMIT = 200;

/**
 * The widest window the roster will answer — **a quarter, not a year.**
 *
 * ── Why this is NOT {@link AGENT_STATS_MAX_WINDOW_DAYS} ─────────────────────
 *
 * The per-agent record's 366 is argued from PAYLOAD size (`buckets × 1`) and it
 * is the right cap for that read for a second reason it does not state: that read
 * is bounded to ONE `agent_user_id`, which is the predicate its occupancy index
 * is reachable through. This one names no agent. `rosterOccupancyTotals`'s
 * `in_window` CTE pulls every state transition for every agent in the ACCOUNT
 * over the window into a `lead()`, so the same 366 days costs ~N times as much in
 * a floor of N — a different question deserving a different bound, not the same
 * number kept for URL symmetry.
 *
 * ── And there is no wall clock behind it ────────────────────────────────────
 *
 * Neither statement may carry a `LIMIT` — the benchmark needs the whole
 * pre-`limit` cohort, and {@link AgencyRosterBenchmark}'s occupancy percentiles
 * need an input that exists in neither statement alone. The server sets no
 * `statement_timeout` and no `query_timeout` anywhere, so a read that runs long
 * holds a pool connection for as long as it takes — the same pool serving
 * authentication, the pacing tick and attempt writes. With no `LIMIT` to shed
 * rows and no timeout to cut the statement off, the WINDOW is the only bound
 * available, which is why it is set from cost rather than inherited.
 *
 * 92 days is a quarter, and it covers every period the console offers — today,
 * this week, this month, and the completed last-week / last-month ranges — with
 * room above the longest of them. A caller wanting a year pages by quarter, and
 * the refusal names the bound so they learn that rather than discovering it.
 */
export const ROSTER_MAX_WINDOW_DAYS = 92;

/** The window, scope-independent filters and ranking one roster read runs over. */
export interface AgentRosterParams {
  /** Inclusive lower bound on `dialed_at` / on the occupancy window. */
  from: Date;
  /** EXCLUSIVE upper bound, same half-open window as {@link AgentStatsParams}. */
  to: Date;
  /** Narrow every row to one campaign; omit for the whole cross-campaign floor. */
  campaignId?: string;
  sort: AgencyRosterSort;
  order: 'asc' | 'desc';
  limit: number;
}

/**
 * `?from=&to=&campaign_id=&sort=&order=&limit=` → {@link AgentRosterParams}.
 *
 * ── The window rules are IMPORTED, except the CAP ───────────────────────────
 *
 * `from`/`to` are required, half-open and parsed by `parseFilterDate` — every one
 * of those is the same rule as {@link parseAgentStatsQuery}, for the same reasons,
 * and the reasons are written out there.
 *
 * The cap is NOT the same. It is {@link ROSTER_MAX_WINDOW_DAYS} (92), not
 * {@link AGENT_STATS_MAX_WINDOW_DAYS} (366), and the argument for keeping them
 * identical — that two adjacent read surfaces accepting different windows is a
 * difference invisible in a URL — loses to the reason they differ: the per-agent
 * read is bounded to ONE `agent_user_id` and this one is the whole account, so the
 * occupancy read behind it differences every transition of every agent on the
 * floor rather than of one person. That is an ~N-fold cost difference in a floor
 * of N, and neither statement here may carry a `LIMIT` (the benchmark needs the
 * whole pre-`limit` cohort) while the server sets no `statement_timeout` anywhere. A
 * whole-floor read and a one-person read are visibly different questions; giving
 * them the same bound for URL symmetry would be dressing that up as consistency.
 * The refusal names the bound, so a caller wanting a year learns to page by
 * quarter rather than discovering it.
 *
 * ── `bucket` is NOT accepted, and neither is `agent_user_id` ─────────────────
 *
 * Not defaulted-and-ignored: both are 400s through the unknown-param check
 * the public API layer applies, because both would be a URL that reads as one question and is
 * answered as another. `agent_user_id` narrowed to named agents belongs to a
 * compare surface, and accepting it here would make `benchmark` mean something
 * different per request under the same name.
 *
 * ── `limit` REFUSES, where the attempt spine's `clampLimit` clamps ───────────
 *
 * `?limit=0`, `?limit=201` and `?limit=abc` are all 400s naming the bound. That
 * is a deliberate divergence from `clampLimit`, which silently pins the value,
 * and the two surfaces differ in a way that justifies it: the spine's `limit` is
 * a page size on a CURSOR-paged list, where a clamped value still returns the
 * next rows and the caller loses nothing but a round trip. The roster's `limit`
 * truncates a RANKED list and there is no cursor to continue with, so a silently
 * changed limit changes which agents are on the page — and `total_agents` is the
 * only hint, which a caller who did not know their limit moved will not read as
 * one. Same rule as everything else here: an invalid value is a 400 with details,
 * never a silent default.
 *
 * `sort` and `order` are DEFAULTED when absent and REFUSED when unknown. Absent
 * is unambiguous (the response echoes both, so a caller can always tell what they
 * got); a stale vocabulary is not, and a client asking for a sort this build does
 * not have must be told rather than handed a differently-ordered page that looks
 * like an answer.
 */
export function parseRosterQuery(query: Record<string, unknown>): FilterParse<AgentRosterParams> {
  const issues: FilterIssue[] = [];

  // Refused rather than silently emptied, exactly as `parseAgentStatsQuery` does:
  // an empty roster reads as a fact about the floor rather than about the request.
  // The ROSTER's cap, not the per-agent read's — see `ROSTER_MAX_WINDOW_DAYS`.
  const { from, to } = parseRequiredWindow(query, ROSTER_MAX_WINDOW_DAYS, issues);

  // Same guard, same reason, as everywhere else here.
  const campaignId = parseCampaignIdParam(query, issues);

  const sort = singleEnum('sort', singleParam(query['sort']), ROSTER_SORTS, issues);
  const order = singleEnum('order', singleParam(query['order']), ROSTER_ORDERS, issues);

  // Parsed through the raw string rather than `Number()` alone: `Number('1.5')` is
  // finite and `Math.floor` would accept it as 1, and `Number('')`/`Number(' ')`
  // are 0 — so a cleared form field would arrive as a refusal naming a bound the
  // caller never typed. `singleParam` has already turned blank into absent.
  const limitRaw = singleParam(query['limit']);
  let limit = ROSTER_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(parsed)
      || parsed < 1 || parsed > ROSTER_MAX_LIMIT) {
      issues.push({
        param: 'limit',
        message: `must be a whole number between 1 and ${ROSTER_MAX_LIMIT}`,
      });
    } else {
      limit = parsed;
    }
  }

  if (issues.length > 0 || !from || !to) {
    // `!from || !to` cannot be reached with an empty issue list — both are
    // required above — but the compiler cannot see that, and returning `ok: true`
    // with a fabricated window would be the worse way to satisfy it.
    return { ok: false, issues: issues.length > 0 ? issues : [{ param: 'from', message: 'is required' }] };
  }

  return {
    ok: true,
    filters: {
      from,
      to,
      ...(campaignId ? { campaignId } : {}),
      sort: sort ?? ROSTER_DEFAULT_SORT,
      order: order ?? ROSTER_DEFAULT_ORDER,
      limit,
    },
  };
}

/**
 * p25 / median / p75 over an already-filtered set of values.
 *
 * ── The filtering is the CALLER's job, and that is the interesting half ──────
 *
 * This function ranks whatever it is handed. Which rows are handed to it — only
 * those whose denominator cleared `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, and never
 * a `null` rate — is the rule stated on `AgencyRosterBenchmark`, and it lives at
 * the call site because the qualifying denominator differs per metric while the
 * ranking does not. Passing a `null` through here would be the failure the whole
 * threshold exists to prevent: JavaScript sorts `null` as 0, so one agent who
 * connected nobody would sit at the bottom of the distribution as a hard 0% and
 * pull p25 down with them.
 *
 * ── `percentile_cont`, not `percentile_disc` ────────────────────────────────
 *
 * Linear interpolation between the two neighbouring values, which is what
 * Postgres's `percentile_cont` computes and what a reader means by "the median".
 * The discrete reading snaps to an actual row, and on a floor of four agents that
 * makes the median one named person's number — which invites reading the
 * benchmark as a comparison against THEM.
 *
 * Empty input yields all three `null`, never 0 — the same rule as every rate on
 * this surface, for the same reason: "nothing qualified" and "the cohort scores
 * zero" are different facts.
 */
export function rosterPercentiles(values: readonly number[]): AgencyRosterPercentiles {
  if (values.length === 0) return { p25: null, median: null, p75: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    // `(n - 1) * fraction` is the `percentile_cont` position: 0 for the first row,
    // n-1 for the last, so a single value returns itself for all three quantiles.
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const low = sorted[lower] as number;
    const high = sorted[upper] as number;
    return low + (high - low) * (position - lower);
  };
  return { p25: at(0.25), median: at(0.5), p75: at(0.75) };
}

/**
 * The value each sort key reads, as the inverted `Record`.
 *
 * `Record<AgencyRosterSort, …>` rather than a `switch`: a tenth sort key added to
 * the union is a missing required key here — a build error that names it — where
 * a `switch` with a `default` would compile and silently rank the new key by
 * whatever the fallback picked. Same idiom, same reason, as {@link ROSTER_SORTS}
 * (which guards the 400) — the two are separate objects because they guard
 * separate failures, and a key present in one and absent from the other is a
 * build error either way.
 */
const ROSTER_SORT_VALUES: Record<
  AgencyRosterSort,
  (row: AgencyRosterAgentRow) => number | string | null
> = {
  attempts: (row) => row.attempts,
  connected: (row) => row.connected,
  connect_rate_pct: (row) => row.connect_rate_pct,
  successes: (row) => row.successes,
  success_rate_pct: (row) => row.success_rate_pct,
  aht_seconds: (row) => row.aht_seconds,
  talk_seconds: (row) => row.talk_seconds,
  occupancy_pct: (row) => row.occupancy_pct,
  agent_user_id: (row) => row.agent_user_id,
};

/**
 * Rank the roster. Returns a new array; the input is not mutated.
 *
 * ── NULLS LAST IN BOTH DIRECTIONS ───────────────────────────────────────────
 *
 * Four of the nine sort keys are nullable, and `null` on them means "no
 * measurable rate" — not zero, not worst, not best. **A null row is not ranked**,
 * so it goes to the end whichever direction was asked for. Both halves of that
 * are load-bearing and both are wrong under a naive comparator:
 *
 *   * Under `desc`, JavaScript's `b - a` on a `null` reads it as 0 and files an
 *     agent who connected nobody at the BOTTOM — plausible, and wrong, because it
 *     asserts a 0% connect rate the data does not support.
 *   * Under `asc` the same coercion puts them at the TOP of "worst connect rate",
 *     which is the same false claim promoted to the first thing a supervisor sees.
 *
 * This is the `ORDER BY … NULLS LAST` the frozen contract specifies, expressed in
 * TypeScript because the ranking cannot happen in SQL — see
 * `AgencyAgentStatsRepository.roster` for why (the occupancy metric arrives from
 * a second statement, and the benchmark needs the whole cohort before `limit`).
 * Being one comparator rather than a SQL fragment plus a fallback is what stops
 * the two from drifting, and it means `sort`/`order` never reach a query at all.
 *
 * ── `agent_user_id` is the tiebreaker on EVERY sort ─────────────────────────
 *
 * Ties are the normal case, not an edge: `successes` is a small integer and a
 * floor of thirty will have several agents on 4, and every null on a nullable key
 * ties with every other null. Without a total order two reads of the same window
 * return the same rows in a different order, which reads as data moving under the
 * reader, and `limit` then makes it worse — it changes WHICH agents are on the
 * page between two identical requests.
 *
 * The tiebreak is always ASCENDING, including under `order=desc`. It is there to
 * be deterministic rather than to be meaningful; reversing it with the direction
 * would be equally deterministic and would make a stable page appear to reshuffle
 * when the reader flipped an unrelated column. When `sort` IS `agent_user_id` the
 * primary comparison already honours `order`, and the tiebreak is unreachable
 * because the ids are unique.
 */
export function sortRosterRows(
  rows: readonly AgencyRosterAgentRow[],
  sort: AgencyRosterSort,
  order: 'asc' | 'desc',
): AgencyRosterAgentRow[] {
  const read = ROSTER_SORT_VALUES[sort];
  const direction = order === 'asc' ? 1 : -1;
  const tiebreak = (a: AgencyRosterAgentRow, b: AgencyRosterAgentRow): number =>
    (a.agent_user_id < b.agent_user_id ? -1 : a.agent_user_id > b.agent_user_id ? 1 : 0);

  return [...rows].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    // Nulls last, direction-independent. Checked before the comparison rather
    // than folded into it, because there is no arithmetic on `null` that produces
    // "unranked" — every coercion produces a position.
    if (left === null || right === null) {
      if (left === null && right === null) return tiebreak(a, b);
      return left === null ? 1 : -1;
    }
    if (left < right) return -direction;
    if (left > right) return direction;
    return tiebreak(a, b);
  });
}
