/**
 * What the three dataset builders share: the run's window as a `ReportRange` and as local days,
 * the tenant/account header, the account roster read (the roster screen's own chain), the
 * Insights range a campaign read is served, labels, cells and the small pure helpers the unit
 * suite pins (masking, sum-preserving rounding). Part of `agency/reports/datasets/`
 * (docs/reports.md "Datasets").
 */
import {
  RESERVED_BREAK_REASON_LABELS,
  type AgencyBreakReason,
  type AgencyDisposition,
} from '@magick-agency/contracts/agency';
import type { ReportDetailColumn, ReportRange, ReportRosterBenchmark } from '@magick-agency/contracts/reports';
import type { AgencyRosterAgentRowWithName, AgencyRosterPage } from '@magick-agency/contracts/api/agency/agency-stats';
import type { AgencyInsightsBucket } from '@magick-agency/contracts/api/agency/insights';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import type { ReportRunRecord } from '../../../db/repositories/agency/report-run.repository.js';
import { agencyAgentStatsRepository, agencyReportDatasetRepository } from '../../../db/repositories/agency.repository.js';
import { getPool } from '@magick-agency/db';
import { parseRosterQuery, ROSTER_MAX_LIMIT } from '../../agent-record.js';
import { enrichAttemptAgentNames } from '../../agency-spine.js';
import { resolveAgentNames, scopeRowsToMembers } from '../../agency-agent-identity.js';
import { parseInsightsRange, type ServedInsightsRange } from '../../insights/range.js';
import { localDayBounds } from '../schedule.js';
import { ReportSubjectUnavailableError } from './types.js';

const log = createChildLogger({ component: 'report-datasets' });

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → days since the epoch (a civil date, no zone). */
function civilDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

const civilDate = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Every local date from `from` to `to`, both inclusive. */
export function localDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = civilDay(from); d <= civilDay(to); d++) out.push(civilDate(d));
  return out;
}

/** One local day of the run's zone: `[start, end)` instants (23 or 25 hours across a clock change). */
export interface LocalDay {
  date: string;
  start: Date;
  end: Date;
}

/** Every local day of the window in `timezone`, in order. */
export function localDays(from: string, to: string, timezone: string): LocalDay[] {
  return localDates(from, to).map((date) => {
    const { start, end } = localDayBounds(date, date, timezone);
    return { date, start, end };
  });
}

/** The dataset's `range` for a run. */
export function reportRange(run: ReportRunRecord): ReportRange {
  return {
    from: run.local_from,
    to: run.local_to,
    timezone: run.timezone,
    days: localDates(run.local_from, run.local_to).length,
    start: run.range_from.toISOString(),
    end: run.range_to.toISOString(),
  };
}

/** The tenant and account a run belongs to; the account must still exist in the tenant. */
export async function runTenancy(run: ReportRunRecord): Promise<{ tenant: { id: string; name: string }; account: { id: string; name: string } }> {
  if (!run.account_id) throw new ReportSubjectUnavailableError('report run has no account');
  const [tenant, account] = await Promise.all([
    tenantRepository.findById(run.tenant_id),
    accountRepository.findByIdInTenant(run.account_id, run.tenant_id),
  ]);
  if (!tenant || !account) throw new ReportSubjectUnavailableError('the report\'s account no longer exists');
  return { tenant: { id: tenant.id, name: tenant.name }, account: { id: account.id, name: account.name } };
}

/**
 * The run's zone as Postgres names it, resolved once per build. A zone Postgres does not know
 * fails the build (`assembly_failed`) with a clear message: the shared reads would otherwise cut
 * the account's days in UTC without saying so (`resolvedZoneCte`) or fail with a bare SQL error.
 */
export async function resolveReportZone(timezone: string): Promise<string> {
  const zone = await agencyReportDatasetRepository.knownZone(timezone);
  if (zone === null) throw new Error(`The report's time zone ${timezone} is not known to the database.`);
  return zone;
}

/** The campaigns of `ids` in the tenant, by id (rows outside the tenant are absent). */
export async function campaignsByIds(ids: readonly string[], tenantId: string): Promise<Map<string, AgencyCampaignRecord>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await getPool().query<AgencyCampaignRecord>(
    'SELECT * FROM agency_campaigns WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid',
    [unique, tenantId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The Insights range a campaign read is served for the run's window: the range routes' own
 * parser (`parseInsightsRange`) over the window's instants, so a report and the Insights tab
 * asked for the same window read the same buckets (`to` stops at the bucket "now" falls in, as on
 * the tab). The window is local-midnight aligned and every zone's offset is a multiple of 15
 * minutes, so it is served exactly as asked.
 */
export function insightsRangeFor(
  campaign: AgencyCampaignRecord,
  run: ReportRunRecord,
  now: Date,
  bucket?: AgencyInsightsBucket,
): ServedInsightsRange {
  const query: Record<string, string> = { from: run.range_from.toISOString(), to: run.range_to.toISOString() };
  if (bucket) query['bucket'] = bucket;
  const parsed = parseInsightsRange(query, { createdAt: new Date(campaign.created_at), now, bucket: bucket !== undefined });
  if (!parsed.ok) throw new Error(`report window refused by the insights range parser: ${parsed.message}`);
  return parsed.range;
}

/** `structuredClone` through JSON: a value exactly as it would cross the wire (Dates to ISO strings). */
export function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The roster screen's read for the window: rows with names, and the benchmark. */
export interface ReportRoster {
  rows: AgencyRosterAgentRowWithName[];
  benchmark: ReportRosterBenchmark;
}

/**
 * The account roster as `GET /proxy/agency/agents/stats` serves it for the window with the
 * report's query (no `campaign_id`, `sort=attempts`, `order=desc`, `limit=200`, the route's
 * maximum; the console's roster defaults to `sort=successes`, so past 200 dialling agents the
 * rows, never the benchmark, can differ from its first page): the internal handler's read (`parseRosterQuery` then `agencyAgentStatsRepository.roster`), the
 * route's membership scope (`scopeRowsToMembers`, departed agents dropped unless
 * `includeInactive`) and its name enrichment. The benchmark is the handler's, untouched by the
 * membership filter, so `includeInactive` changes the rows only.
 */
export async function readAccountRoster(q: {
  tenantId: string;
  accountId: string;
  from: Date;
  to: Date;
  includeInactive: boolean;
}): Promise<ReportRoster> {
  const parsed = parseRosterQuery({
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    sort: 'attempts',
    order: 'desc',
    limit: String(ROSTER_MAX_LIMIT),
  });
  if (!parsed.ok) throw new Error(`report roster window refused: ${parsed.issues.map((i) => `${i.param} ${i.message}`).join('; ')}`);
  const page = wire(await agencyAgentStatsRepository.roster({ tenantId: q.tenantId, accountId: q.accountId }, parsed.filters));
  const scoped = await scopeRowsToMembers(q.tenantId, {
    body: page as unknown as Record<string, unknown>,
    rows: page.rows,
    agentIdOf: (row) => row.agent_user_id,
    accountId: q.accountId,
    includeInactive: q.includeInactive,
    surface: 'report roster',
    enrich: (body) => enrichAttemptAgentNames(body, q.tenantId, resolveAgentNames, (err) => {
      log.warn({ tenantId: q.tenantId, err: err instanceof Error ? err.message : String(err) }, 'report roster: name resolution failed; names are null');
    }),
  }) as AgencyRosterPage;
  return {
    rows: scoped.rows,
    benchmark: { cohort: scoped.benchmark, pool_size: scoped.benchmark.agents_rated },
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * RP7: a phone number to its last four digits, the rest replaced (`****1234`). Fewer than four
 * digits shows none of them. Null stays null.
 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length < 4 ? '****' : `****${digits.slice(-4)}`;
}

/**
 * Whole numbers for `values` that sum to `Math.round(Σ values)`: each value floored, then the
 * remaining units given to the largest fractional parts (earliest first on a tie). So day rows
 * of whole seconds still sum to the window's whole-second total, and parts to their whole.
 */
export function roundPreservingSum(values: readonly number[]): number[] {
  const total = Math.round(values.reduce((s, v) => s + v, 0));
  const floors = values.map((v) => Math.floor(v));
  let left = total - floors.reduce((s, v) => s + v, 0);
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

/** Seconds as a whole-seconds cell, or null. */
export function secondsCell(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** An instant as an ISO cell, or null. */
export function instantCell(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/** A column. */
export const col = (key: string, label: string, type: ReportDetailColumn['type']): ReportDetailColumn => ({ key, label, type });

/** Outcome codes as printed (attempt outcomes are wire codes; the sheet shows words). */
const OUTCOME_LABELS: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  machine: 'Answering machine',
  invalid: 'Invalid number',
  abandoned: 'Abandoned',
  agent_disconnected: 'Agent disconnected',
  orphaned: 'Closed by the system',
  canceled: 'Cancelled',
};

/** An attempt or call outcome in words; an unknown code is shown as itself. */
export function outcomeLabel(outcome: string | null): string | null {
  return outcome === null ? null : OUTCOME_LABELS[outcome] ?? outcome;
}

/** Disposition codes that are the system's, not a catalog's. */
const SYSTEM_DISPOSITION_LABELS: Record<string, string> = {
  no_disposition: 'No outcome recorded (closed automatically)',
  redialed: 'Redialled',
};

/** The words for a conversation closed without a code. */
export const NO_CODE_LABEL = 'Closed without an outcome';

/**
 * A disposition code's label: the catalog's (each campaign's CURRENT catalog, so a renamed code
 * shows its new name on old calls), else the system's words, else the code marked as retired.
 */
export function dispositionLabel(code: string | null, catalog: readonly AgencyDisposition[] | null | undefined): string {
  if (code === null) return NO_CODE_LABEL;
  const entry = Array.isArray(catalog) ? catalog.find((d) => d && d.code === code) : undefined;
  if (entry && typeof entry.label === 'string' && entry.label.length > 0) return entry.label;
  return SYSTEM_DISPOSITION_LABELS[code] ?? `${code} (no longer in the outcome list)`;
}

/** The label of a break reason across the campaigns' catalogs, the reserved codes, or the code itself. */
export function breakReasonLabel(code: string, catalogs: Iterable<readonly AgencyBreakReason[] | null | undefined>): string {
  if (code === 'unspecified') return 'No reason given';
  const reserved = (RESERVED_BREAK_REASON_LABELS as Readonly<Record<string, string>>)[code];
  if (reserved) return reserved;
  for (const catalog of catalogs) {
    const entry = Array.isArray(catalog) ? catalog.find((r) => r && r.code === code) : undefined;
    if (entry && typeof entry.label === 'string' && entry.label.length > 0) return entry.label;
  }
  return code;
}

/** Session kinds and clients in words. */
export const SESSION_KIND_LABELS: Record<string, string> = { campaign: 'Campaign', softphone: 'Soft phone' };
export const CLIENT_KIND_LABELS: Record<string, string> = { web: 'Web', mobile: 'Mobile app' };

/** Agent states in words (reserved is folded into available, as every report figure folds it). */
export const STATE_LABELS: Record<string, string> = {
  available: 'Available',
  reserved: 'Available',
  on_call: 'On a call',
  wrapup: 'Wrap-up',
  break: 'Break',
};
