/**
 * Compare agents' request rules (docs/compare-agents.md §8; the field rules are the contract's doc
 * comments, `packages/contracts/src/api/agency/compare.ts`). Pure: the routes parse a body with the
 * schemas here (a body that fails one is the generic agency 400), look up the campaign, then ask
 * these functions which compare refusal, if any, applies, in the order the contract lists them.
 * Every metric rule is the shared one (`compareMetricRefProblem`, `resolveCompareMetrics`), so the
 * console's picker and the server cannot disagree.
 *
 * The English fallback copy of every refusal is here too (`COMPARE_ERROR_MESSAGES`): simple Indian
 * English, British spelling (AS15); the console keys off the code and shows its own words.
 */
import { z } from 'zod';
import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_LENSES,
  COMPARE_MAX_METRICS,
  COMPARE_PAGE_MAX_AGENTS,
  COMPARE_VIEW_NAME_MAX,
  compareMetricId,
  compareMetricRefProblem,
  compareWindowProblem,
  type AgencyCompareErrorCode,
  type AgencyCompareMetricInfo,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { REPORT_MAX_WINDOW_DAYS } from '@magick-agency/contracts/api/agency/reports';
import { resolveCompareMetrics } from '@magick-agency/domain/agent-compare';
import { UUID_RE } from '../../utils/uuid.js';
import { isRequestZone } from '../zone.js';

/** English fallback copy per code (AS15). The console shows its own words for a known code. */
export const COMPARE_ERROR_MESSAGES: Readonly<Record<AgencyCompareErrorCode, string>> = Object.freeze({
  compare_campaign_required: 'Choose a campaign to compare its agents.',
  compare_campaign_not_found: 'Campaign not found in this account.',
  compare_too_many_agents: `Pick at most ${COMPARE_PAGE_MAX_AGENTS} agents to compare.`,
  compare_too_many_metrics: `Choose at most ${COMPARE_MAX_METRICS} metrics.`,
  compare_metric_invalid: 'A metric you chose cannot be compared on this campaign.',
  compare_window_invalid: `Choose dates ending today or earlier, at most ${REPORT_MAX_WINDOW_DAYS} days or one calendar month.`,
  compare_timezone_invalid: 'The time zone is missing or not recognised.',
  compare_agent_not_in_cohort: 'An agent you picked made no calls on this campaign in these dates.',
  compare_busy: 'Too many comparisons are running right now. Try again in a moment.',
  compare_timed_out: 'The comparison took too long. Try a shorter date range.',
  compare_view_not_found: 'Saved view not found.',
  compare_view_invalid: 'The saved view is not valid.',
  compare_view_limit: 'You have too many saved views. Delete one to save another.',
});

const uuid = z.string().regex(UUID_RE, 'must be a UUID');
const lowerDistinct = (ids: readonly string[]): boolean => new Set(ids.map((id) => id.toLowerCase())).size === ids.length;

/**
 * `POST /compare/query` body, shape only. `campaign_id` and `timezone` are optional here because
 * their absence has a compare code of its own (`compare_campaign_required`,
 * `compare_timezone_invalid`); the agent and metric counts too (`compare_too_many_*`). An empty or
 * duplicated `agent_ids` and an empty `metrics` are the generic 400 (the contract's rule).
 */
export const compareQueryBodySchema = z.object({
  campaign_id: z.string().optional(),
  agent_ids: z.array(uuid).min(1).refine(lowerDistinct, 'agent_ids must be distinct'),
  metrics: z.array(z.unknown()).min(1),
  trend: z.unknown().optional(),
  from: z.string(),
  to: z.string(),
  timezone: z.string().optional(),
});
export type CompareQueryBody = z.infer<typeof compareQueryBodySchema>;

/** `GET /compare/options` query, shape only (each value a single string). */
export const compareOptionsQuerySchema = z.object({
  campaign_id: z.string().optional(),
  from: z.string(),
  to: z.string(),
  timezone: z.string().optional(),
});

/** `GET /compare/views` query. */
export const compareViewListQuerySchema = z.object({
  campaign_id: z.string().optional(),
});

/** `POST /compare/views` body, shape only: the content rules are {@link checkCompareView}'s. */
export const compareViewCreateSchema = z.object({
  name: z.string(),
  lens: z.string(),
  metrics: z.array(z.unknown()),
  trend: z.unknown().optional(),
  campaign_id: z.string().nullable().optional(),
  shared: z.boolean().optional(),
  is_campaign_default: z.boolean().optional(),
});
export type CompareViewCreateBody = z.infer<typeof compareViewCreateSchema>;

/** `PATCH /compare/views/:id` body: any subset of the create fields. */
export const compareViewPatchSchema = compareViewCreateSchema.partial();
export type CompareViewPatchBody = z.infer<typeof compareViewPatchSchema>;

/** A metric ref as stored and echoed: only its own fields, never whatever else a client sent. */
export function cleanMetricRef(ref: AgencyCompareMetricRef): AgencyCompareMetricRef {
  if (ref.kind === 'builtin') return { kind: 'builtin', key: ref.key };
  return { kind: 'outcomes', codes: [...ref.codes], better: ref.better, ...(ref.label !== undefined ? { label: ref.label } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An id (a campaign, a view) as the routes accept it: a UUID, lower-cased; null for anything else. */
export function uuidOf(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** What {@link checkCompareMetrics} resolved. */
export interface CompareResolvedMetrics {
  metrics: AgencyCompareMetricInfo[];
  trend: AgencyCompareMetricInfo | null;
}

/**
 * The agents and metrics of a query against the campaign's CURRENT catalog, in the contract's
 * order: `compare_too_many_agents`, `compare_too_many_metrics`, then `compare_metric_invalid` (a
 * malformed ref, two refs with one id, a code not in the catalog, a promise metric on a catalog
 * without promises, a trend that is not countable).
 */
export function checkCompareMetrics(
  body: Pick<CompareQueryBody, 'agent_ids' | 'metrics' | 'trend'>,
  codes: readonly AgencyCompareOutcomeCode[],
): { ok: true; agentIds: string[]; resolved: CompareResolvedMetrics } | { ok: false; code: AgencyCompareErrorCode } {
  if (body.agent_ids.length > COMPARE_PAGE_MAX_AGENTS) return { ok: false, code: 'compare_too_many_agents' };
  if (body.metrics.length > COMPARE_MAX_METRICS) return { ok: false, code: 'compare_too_many_metrics' };
  if (!body.metrics.every(isObject)) return { ok: false, code: 'compare_metric_invalid' };
  const trend = body.trend;
  if (trend !== undefined && trend !== null && !isObject(trend)) return { ok: false, code: 'compare_metric_invalid' };
  const refs = body.metrics as unknown as AgencyCompareMetricRef[];
  const trendRef = (trend ?? null) as AgencyCompareMetricRef | null;
  const resolution = resolveCompareMetrics(refs, trendRef, codes, COMPARE_MAX_METRICS);
  if (!resolution.ok) return { ok: false, code: 'compare_metric_invalid' };
  const clean = (m: AgencyCompareMetricInfo): AgencyCompareMetricInfo => ({ ...m, ref: cleanMetricRef(m.ref) });
  return {
    ok: true,
    agentIds: body.agent_ids.map((id) => id.toLowerCase()),
    resolved: { metrics: resolution.metrics.map(clean), trend: resolution.trend === null ? null : clean(resolution.trend) },
  };
}

/**
 * The zone and the window, in that order (`compare_timezone_invalid`, `compare_window_invalid`).
 * The zone must pass `isRequestZone` (the reports' rule: `Intl`, trimmed, at most 64 characters) AND
 * be one Postgres can cut days in: `databaseZone` is the name `postgresZoneName` found for it (its
 * own, or a legacy name's current one), null when it found none. The route asks Postgres only for
 * a zone that passes `isRequestZone`, and passes null for any other. `today` is the local date of
 * now in that zone.
 */
export function checkCompareWindow(
  q: { from: string; to: string; timezone: string | undefined },
  databaseZone: string | null,
  todayIn: (zone: string) => string,
): { ok: true; timezone: string; databaseTimezone: string } | { ok: false; code: AgencyCompareErrorCode } {
  const tz = q.timezone;
  if (!isRequestZone(tz) || databaseZone === null) return { ok: false, code: 'compare_timezone_invalid' };
  if (compareWindowProblem(q.from, q.to, todayIn(tz)) !== null) return { ok: false, code: 'compare_window_invalid' };
  return { ok: true, timezone: tz, databaseTimezone: databaseZone };
}

/** A view's content before its campaign is looked up: every field resolved to its stored value. */
export interface CompareViewDraft {
  name: unknown;
  lens: unknown;
  metrics: unknown[];
  trend: unknown;
  campaign_id: string | null;
  shared: boolean;
  is_campaign_default: boolean;
}

/** A view's content as stored, once {@link checkCompareView} accepts it. */
export interface CheckedCompareView {
  name: string;
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  campaign_id: string | null;
  shared: boolean;
  is_campaign_default: boolean;
}

/**
 * A view's content (`compare_view_invalid` on any failure): the name (1 to
 * `COMPARE_VIEW_NAME_MAX` after trimming; stored trimmed), the lens, 1 to `COMPARE_MAX_METRICS` refs
 * with distinct ids each passing `compareMetricRefProblem`, a `countable` trend or none; with a
 * campaign (`codes` its current catalog), every code in it and no promise metric on a catalog
 * without promises; a default needs the campaign and `shared`. Without a campaign (`codes`
 * null) the codes are checked when a query applies the view.
 */
export function checkCompareView(draft: CompareViewDraft, codes: readonly AgencyCompareOutcomeCode[] | null): CheckedCompareView | null {
  if (typeof draft.name !== 'string') return null;
  const name = draft.name.trim();
  if (name.length === 0 || name.length > COMPARE_VIEW_NAME_MAX) return null;
  if (typeof draft.lens !== 'string' || !(COMPARE_LENSES as readonly string[]).includes(draft.lens)) return null;
  if (draft.is_campaign_default && (draft.campaign_id === null || !draft.shared)) return null;
  if (draft.metrics.length === 0 || draft.metrics.length > COMPARE_MAX_METRICS || !draft.metrics.every(isObject)) return null;
  const trend = draft.trend ?? null;
  if (trend !== null && !isObject(trend)) return null;
  const refs = draft.metrics as unknown as AgencyCompareMetricRef[];
  const trendRef = trend as AgencyCompareMetricRef | null;

  if (codes !== null) {
    const resolution = resolveCompareMetrics(refs, trendRef, codes, COMPARE_MAX_METRICS);
    if (!resolution.ok) return null;
  } else {
    // No campaign: the shape rules only (the catalog is the campaign's, checked on use).
    const ids = new Set<string>();
    for (const ref of refs) {
      if (compareMetricRefProblem(ref) !== null) return null;
      const id = compareMetricId(ref);
      if (ids.has(id)) return null;
      ids.add(id);
    }
    if (trendRef !== null) {
      if (compareMetricRefProblem(trendRef) !== null) return null;
      const countable = trendRef.kind === 'outcomes' || COMPARE_BUILTIN_METRICS[trendRef.key].countable;
      if (!countable) return null;
    }
  }
  return {
    name,
    lens: draft.lens as CompareLens,
    metrics: refs.map(cleanMetricRef),
    trend: trendRef === null ? null : cleanMetricRef(trendRef),
    campaign_id: draft.campaign_id,
    shared: draft.shared,
    is_campaign_default: draft.is_campaign_default,
  };
}
