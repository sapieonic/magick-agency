/**
 * `AgencyInsightsPacingRepository`: the pacing history (IN2, `docs/insights.md`), one row per
 * campaign per UTC minute in `agency_campaign_pacing_minutes` (migration 0013).
 *
 * Writes are additive upserts only (`x = t.x + EXCLUDED.x`), so any number of writers of one
 * minute add up and nothing is rewritten from memory: the pacing leader's batch
 * ({@link upsertMinutes}, from `agency/pacing/pacing-history.ts`) and the single-row writes
 * outside the tick ({@link addToMinute}: a wrap-up redial refused at the limit, an our-fault
 * retirement). The read is {@link pacingHistory}, for the insights `health` section.
 *
 * ── The stall rule ────────────────────────────────────────────────────────────
 * Computed in SQL, in {@link pacingHistory}'s statement, from each minute's counters:
 *
 *  1. A minute is **stalled** when it has ticks and at least half of them dialled nothing
 *     (`sum(idle_*) * 2 >= ticks`). `ticks` counts only ticks on a `running` campaign, so a
 *     paused, stopping or unled minute is never stalled.
 *  2. Its reason is `outside_calling_hours` when the campaign's own calling window was closed
 *     for at least half its ticks (`outside_hours_ticks * 2 >= ticks`): overnight, "no contacts"
 *     is the consequence of the window, not the cause. Otherwise the idle reason with the most
 *     ticks, ties broken in `AGENCY_PACING_IDLE_REASONS` order.
 *  3. An **episode** is a run of consecutive minutes (no gap: a minute with no row breaks it)
 *     stalled for the same reason. Episodes are cut at the range edges (`started_at` no earlier
 *     than `from`, `ended_at` no later than `to`), and `ended_at` is null while it is still
 *     going: its last minute is the newest minute of the range, that minute is the current one
 *     or the one before it (the leader flushes every ~15 s, so the current minute may not be
 *     written yet), and the range reaches now.
 *
 * `minutes_by_reason` counts stalled minutes per reason. `concurrency_limit_minutes` is
 * different on purpose: the minutes in which at least one tick found no free slot
 * (`idle_no_slots > 0`), stalled or not, i.e. how often the account limit held pacing back.
 */
import { getPool } from '@magick-agency/db';
import {
  AGENCY_PACING_IDLE_REASONS,
  type AgencyInsightsStallEpisode,
  type AgencyPacingIdleReason,
} from '@magick-agency/contracts/api/agency/insights';

/** Every counter column, in table order. The accumulator's slots follow this order. */
export const PACING_HISTORY_FIELDS = [
  'ticks',
  'outside_hours_ticks',
  'idle_no_agents',
  'idle_no_slots',
  'idle_no_contacts',
  'idle_no_reservations',
  'idle_no_caller_ids',
  'idle_nothing_due',
  'calling_hours_deferrals',
  'dnc_unavailable_halts',
  'dials_placed',
  'predial_dnc_suppressed',
  'predial_invalid_suppressed',
  'our_fault_retired',
  'redials_refused_at_limit',
] as const;

export type PacingHistoryField = (typeof PACING_HISTORY_FIELDS)[number];

/** The idle column of each reason (the metric label → the column). */
export const PACING_IDLE_FIELD: Readonly<Record<AgencyPacingIdleReason, PacingHistoryField>> = {
  no_agents: 'idle_no_agents',
  no_slots: 'idle_no_slots',
  no_contacts: 'idle_no_contacts',
  no_reservations: 'idle_no_reservations',
  no_caller_ids: 'idle_no_caller_ids',
  nothing_due: 'idle_nothing_due',
};

/** One minute's counts for one campaign, in {@link PACING_HISTORY_FIELDS} order. */
export interface PacingMinuteRow {
  campaignId: string;
  tenantId: string;
  /** Epoch ms of the minute's start (a whole UTC minute). */
  minuteStart: number;
  counts: ArrayLike<number>;
}

/** The most episodes {@link AgencyInsightsPacingRepository.pacingHistory} returns (the newest). */
export const PACING_HISTORY_MAX_EPISODES = 500;

export type AgencyStallReason = AgencyPacingIdleReason | 'outside_calling_hours';

export interface AgencyPacingHistory {
  /** Stalled minutes in range, per reason (the rule in this file's header). */
  minutes_by_reason: Record<AgencyStallReason, number>;
  /** Oldest first; the newest {@link PACING_HISTORY_MAX_EPISODES} when there are more. */
  episodes: AgencyInsightsStallEpisode[];
  /** True when older episodes were left out by the cap. */
  episodes_truncated: boolean;
  /** Minutes with at least one `no_slots` tick. */
  concurrency_limit_minutes: number;
  outside_calling_hours_deferrals: number;
  dnc_unavailable_halts: number;
  predial_dnc_suppressed: number;
  predial_invalid_suppressed: number;
  our_fault_retired: number;
  redials_refused_at_limit: number;
  dials_placed: number;
  ticks: number;
  /** The campaign's first recorded minute (any range), or null when nothing was ever recorded. */
  history_since: string | null;
}

const MINUTE_MS = 60_000;

const COLUMN_LIST = PACING_HISTORY_FIELDS.join(', ');
const U_COLUMN_LIST = PACING_HISTORY_FIELDS.map((f) => `u.${f}`).join(', ');
const ADD_SET = PACING_HISTORY_FIELDS
  .map((f) => `${f} = t.${f} + EXCLUDED.${f}`)
  .join(',\n              ');

const IDLE_SUM_SQL = AGENCY_PACING_IDLE_REASONS.map((r) => `m.${PACING_IDLE_FIELD[r]}`).join(' + ');
const IDLE_MAX_SQL = `GREATEST(${AGENCY_PACING_IDLE_REASONS.map((r) => `m.${PACING_IDLE_FIELD[r]}`).join(', ')})`;
/** The dominant idle reason, ties in list order. */
const DOMINANT_SQL = `CASE ${IDLE_MAX_SQL} ${AGENCY_PACING_IDLE_REASONS.map(
  (r) => `WHEN m.${PACING_IDLE_FIELD[r]} THEN '${r}'`).join(' ')} END`;
/** The stall rule (header): a minute's reason, or NULL when it was not stalled. */
const MINUTE_REASON_SQL = `CASE
           WHEN m.ticks = 0 OR (${IDLE_SUM_SQL}) * 2 < m.ticks THEN NULL
           WHEN m.outside_hours_ticks * 2 >= m.ticks THEN 'outside_calling_hours'
           ELSE ${DOMINANT_SQL}
         END`;

function emptyByReason(): Record<AgencyStallReason, number> {
  const out = { outside_calling_hours: 0 } as Record<AgencyStallReason, number>;
  for (const r of AGENCY_PACING_IDLE_REASONS) out[r] = 0;
  return out;
}

export class AgencyInsightsPacingRepository {
  /**
   * Add a batch of minutes, one statement. Rows naming the same (campaign, minute) are summed
   * first (an `ON CONFLICT DO UPDATE` may not touch one row twice), and the rest are sent in key
   * order, so two writers' batches lock rows in the same order and cannot deadlock. A row whose
   * campaign no longer exists is dropped (joined against `agency_campaigns`), so a campaign
   * deleted between the count and the flush cannot fail the batch for every other campaign.
   * Returns the rows written.
   */
  async upsertMinutes(rows: readonly PacingMinuteRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const merged = new Map<string, { campaignId: string; tenantId: string; minuteStart: number; counts: number[] }>();
    for (const row of rows) {
      const key = `${row.campaignId}|${row.minuteStart}`;
      const hit = merged.get(key);
      if (hit) {
        for (let i = 0; i < PACING_HISTORY_FIELDS.length; i++) hit.counts[i]! += row.counts[i] ?? 0;
      } else {
        merged.set(key, {
          campaignId: row.campaignId, tenantId: row.tenantId, minuteStart: row.minuteStart,
          counts: PACING_HISTORY_FIELDS.map((_, i) => row.counts[i] ?? 0),
        });
      }
    }
    const sorted = [...merged.values()].sort((a, b) =>
      a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : a.minuteStart - b.minuteStart);
    const columns: unknown[][] = PACING_HISTORY_FIELDS.map((_, i) => sorted.map((r) => r.counts[i]));
    const values: unknown[] = [
      sorted.map((r) => r.campaignId),
      sorted.map((r) => new Date(r.minuteStart)),
      sorted.map((r) => r.tenantId),
      ...columns,
    ];
    const unnestArgs = ['$1::uuid[]', '$2::timestamptz[]', '$3::uuid[]',
      ...PACING_HISTORY_FIELDS.map((_, i) => `$${i + 4}::int[]`)].join(', ');
    const { rowCount } = await getPool().query(
      `INSERT INTO agency_campaign_pacing_minutes AS t (campaign_id, minute_start, tenant_id, ${COLUMN_LIST})
       SELECT u.campaign_id, u.minute_start, u.tenant_id, ${U_COLUMN_LIST}
         FROM unnest(${unnestArgs}) WITH ORDINALITY AS u(campaign_id, minute_start, tenant_id, ${COLUMN_LIST}, ord)
         JOIN agency_campaigns c ON c.id = u.campaign_id
        ORDER BY u.ord
       ON CONFLICT (campaign_id, minute_start) DO UPDATE
          SET ${ADD_SET}`,
      values,
    );
    return rowCount ?? 0;
  }

  /**
   * Add `n` to one counter of the minute `at` falls in: the single-row write for events outside
   * the pacing tick. A campaign that no longer exists writes nothing.
   */
  async addToMinute(input: {
    campaignId: string;
    tenantId: string;
    field: PacingHistoryField;
    at?: Date;
    n?: number;
  }): Promise<void> {
    const at = (input.at ?? new Date()).getTime();
    const counts = PACING_HISTORY_FIELDS.map((f) => (f === input.field ? input.n ?? 1 : 0));
    await this.upsertMinutes([{
      campaignId: input.campaignId, tenantId: input.tenantId, minuteStart: at - (at % MINUTE_MS), counts,
    }]);
  }

  /**
   * The pacing history of one campaign over `[from, to)`, for the insights `health` read: the
   * minutes whose start lies in `[floor_minute(from), to)`, through the primary key (one range
   * scan of one campaign; 92 days is at most 132,480 rows). One statement: the totals, the stall
   * classification and the episodes are computed from the same rows. The rule is this file's
   * header.
   */
  async pacingHistory(
    campaignId: string,
    tenantId: string,
    range: { from: Date; to: Date },
    opts: { now?: Date; maxEpisodes?: number } = {},
  ): Promise<AgencyPacingHistory> {
    const now = opts.now ?? new Date();
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const fromMinute = new Date(fromMs - (((fromMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS));
    const maxEpisodes = opts.maxEpisodes ?? PACING_HISTORY_MAX_EPISODES;
    const sum = (f: PacingHistoryField) => `COALESCE(sum(m.${f}), 0)::bigint`;
    const { rows } = await getPool().query<{
      totals: Record<string, number | string>;
      by_reason: Array<{ reason: AgencyStallReason; minutes: number }> | null;
      episodes: Array<{ reason: AgencyStallReason; started: string; last_minute: string; minutes: number }> | null;
      episode_count: number;
      last_minute: Date | null;
      history_since: Date | null;
    }>(
      `WITH m AS MATERIALIZED (
         SELECT m.*, ${MINUTE_REASON_SQL} AS reason
           FROM agency_campaign_pacing_minutes m
          WHERE m.campaign_id = $1::uuid AND m.tenant_id = $2::uuid
            AND m.minute_start >= $3::timestamptz AND m.minute_start < $4::timestamptz
       ),
       isl AS (
         SELECT m.reason, m.minute_start,
                m.minute_start - make_interval(mins => (row_number() OVER (PARTITION BY m.reason ORDER BY m.minute_start))::int) AS grp
           FROM m WHERE m.reason IS NOT NULL
       ),
       ep AS (
         SELECT reason, min(minute_start) AS started, max(minute_start) AS last_minute, count(*)::int AS minutes
           FROM isl GROUP BY reason, grp
       )
       SELECT
         (SELECT json_build_object(
                   'ticks', ${sum('ticks')},
                   'calling_hours_deferrals', ${sum('calling_hours_deferrals')},
                   'dnc_unavailable_halts', ${sum('dnc_unavailable_halts')},
                   'dials_placed', ${sum('dials_placed')},
                   'predial_dnc_suppressed', ${sum('predial_dnc_suppressed')},
                   'predial_invalid_suppressed', ${sum('predial_invalid_suppressed')},
                   'our_fault_retired', ${sum('our_fault_retired')},
                   'redials_refused_at_limit', ${sum('redials_refused_at_limit')},
                   'concurrency_limit_minutes', count(*) FILTER (WHERE m.idle_no_slots > 0))
            FROM m) AS totals,
         (SELECT json_agg(json_build_object('reason', r.reason, 'minutes', r.n))
            FROM (SELECT reason, count(*)::int AS n FROM m WHERE reason IS NOT NULL GROUP BY reason) r) AS by_reason,
         (SELECT json_agg(json_build_object('reason', e.reason, 'started', e.started, 'last_minute', e.last_minute,
                                            'minutes', e.minutes) ORDER BY e.started)
            FROM (SELECT * FROM ep ORDER BY started DESC LIMIT $5::int) e) AS episodes,
         (SELECT count(*)::int FROM ep) AS episode_count,
         (SELECT max(minute_start) FROM m) AS last_minute,
         (SELECT min(p.minute_start) FROM agency_campaign_pacing_minutes p
           WHERE p.campaign_id = $1::uuid AND p.tenant_id = $2::uuid) AS history_since`,
      [campaignId, tenantId, fromMinute, range.to, maxEpisodes],
    );
    const row = rows[0]!;
    const totals = row.totals;
    const n = (k: string) => Number(totals[k] ?? 0);

    const minutesByReason = emptyByReason();
    for (const r of row.by_reason ?? []) minutesByReason[r.reason] = r.minutes;

    const nowMs = now.getTime();
    const nowMinute = nowMs - (nowMs % MINUTE_MS);
    const lastMinuteMs = row.last_minute ? row.last_minute.getTime() : null;
    const rangeReachesNow = toMs > nowMs;
    const episodes: AgencyInsightsStallEpisode[] = (row.episodes ?? []).map((e) => {
      const startedMs = Date.parse(e.started);
      const lastMs = Date.parse(e.last_minute);
      const ongoing = rangeReachesNow && lastMs === lastMinuteMs && lastMs >= nowMinute - MINUTE_MS;
      return {
        reason: e.reason,
        started_at: new Date(Math.max(startedMs, fromMs)).toISOString(),
        ended_at: ongoing ? null : new Date(Math.min(lastMs + MINUTE_MS, toMs)).toISOString(),
        minutes: e.minutes,
      };
    });

    return {
      minutes_by_reason: minutesByReason,
      episodes,
      episodes_truncated: row.episode_count > episodes.length,
      concurrency_limit_minutes: n('concurrency_limit_minutes'),
      outside_calling_hours_deferrals: n('calling_hours_deferrals'),
      dnc_unavailable_halts: n('dnc_unavailable_halts'),
      predial_dnc_suppressed: n('predial_dnc_suppressed'),
      predial_invalid_suppressed: n('predial_invalid_suppressed'),
      our_fault_retired: n('our_fault_retired'),
      redials_refused_at_limit: n('redials_refused_at_limit'),
      dials_placed: n('dials_placed'),
      ticks: n('ticks'),
      history_since: row.history_since ? row.history_since.toISOString() : null,
    };
  }
}

export const agencyInsightsPacingRepository = new AgencyInsightsPacingRepository();
