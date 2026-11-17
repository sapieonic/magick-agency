/**
 * `AgencyListenHistoryRepository`: the account's listening history (docs/listening.md §12, LS19),
 * read from `agency_listen_sessions` (`0047_listen_sessions.sql`), every call type.
 *
 * ── One entry is a visit, merged here ───────────────────────────────────────
 * A supervisor's reconnects write one row per attach. The statement merges a supervisor's
 * sessions on one call into one visit while each starts at most `mergeGapMs`
 * (`AGENCY_LISTEN_HISTORY_MERGE_GAP_MS`) after every earlier session of the visit ended, or
 * while an earlier one is still open (a reconnect often starts before the server has noticed the
 * old socket is gone). A visit's time listened counts each instant once: a session's share starts
 * where the earlier ones ended. The merge runs over the sessions the filters keep (the date range
 * filters sessions by their start), so the page and the CSV, which drain the same read, agree.
 *
 * ── Live sessions only ──────────────────────────────────────────────────────
 * Only sessions that went live (`live_at` set, `0048_listen_sessions_unverified.sql`, LS22 c) are
 * read, as "Listened to by" reads them (`listForCall`): a row the upgrade wrote and then refused
 * carried no audio, so it neither shows nor bridges two visits.
 *
 * ── Keyset, newest first ────────────────────────────────────────────────────
 * Ordered by the visit's start and its first listen id, both descending; the cursor carries the
 * start at microsecond precision (`keysetAtSql`, `@magick-agency/domain/keyset-cursor`). A visit's
 * start and first id never change once written (a later session can only join it), so a page
 * boundary does not move under a reader.
 *
 * ── Cost: one page's sessions, not the account's (LS22 t) ────────────────────
 * A visit's start is the session that starts it: no earlier session of the same supervisor on the
 * same call (among those the filters keep) is open, or ended within the gap, when it starts, which
 * is the window's own rule (`starts_visit`) asked of one session. So the page's visits are found
 * first (`starts`): the account's live sessions walked newest first from the cursor on
 * `idx_agency_listen_sessions_account_started` (0049), each probed on its call, cut at the page.
 * Only then are their calls' sessions windowed and merged. A page reads its visits and their
 * reconnects, whatever the account has kept; the CSV's 100 pages read the file's rows once.
 *
 * The call's row (`agency_calls`, no foreign key: it purges on its own horizon), the campaign, the
 * inbound route and the roster contact are LEFT joins: a session outlives them, and its entry
 * still shows who listened and when. Full numbers leave here; the public layer masks them.
 * Tenant and account scoped; ids validated at the edge.
 */
import { getPool } from '@magick-agency/db';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyCallOrigin, AgencyListenEndReason } from '@magick-agency/contracts/agency';
import { contactNameContextSql } from './sql-fragments.js';

export interface ListenHistoryQuery {
  tenantId: string;
  accountId: string;
  listenerUserId?: string | null;
  agentUserId?: string | null;
  /** Sessions started at or after. */
  from?: Date | null;
  /** Sessions started before (exclusive). */
  to?: Date | null;
  /** Rows after this visit (older), or the newest. */
  before?: AgencyKeysetPosition | null;
  limit: number;
  /** Merge sessions this close together (ms). */
  mergeGapMs: number;
}

/** One visit, as the internal handler reads it (full number; no user names). */
export interface ListenHistoryVisitRow {
  /** The first session's id. */
  id: string;
  listen_ids: string[];
  call_id: string;
  origin: AgencyCallOrigin;
  correlation_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  inbound_route_name: string | null;
  listener_user_id: string;
  agent_user_id: string;
  /** E.164; '' for a withheld caller; null when the call's row is gone. */
  customer_phone: string | null;
  contact_context: Record<string, unknown> | null;
  started_at: Date;
  /** The keyset position of `started_at`, microseconds (`keysetAtSql`). */
  started_at_key: string;
  ended_at: Date | null;
  /** Seconds, as text from SQL; null while a session is open. */
  listened_seconds: string | null;
  end_reason: AgencyListenEndReason | null;
}

/**
 * The sessions the filters keep (`ls`): the tenant, the account, live only, the supervisor, the
 * agent and the start's range. Shared by the walk, its probe and the window, so they agree.
 */
const keptBy = (ls: string) => `${ls}.tenant_id = $1::uuid AND ${ls}.account_id = $2::uuid
       AND ${ls}.live_at IS NOT NULL
       AND ($3::uuid IS NULL OR ${ls}.listener_user_id = $3::uuid)
       AND ($4::uuid IS NULL OR ${ls}.agent_user_id = $4::uuid)
       AND ($5::timestamptz IS NULL OR ${ls}.started_at >= $5::timestamptz)
       AND ($6::timestamptz IS NULL OR ${ls}.started_at < $6::timestamptz)`;

/** The history's statement; exported for its tests. `$1` tenant … `$9` limit (+1 read ahead). */
export const LISTEN_HISTORY_SQL = `
  WITH starts AS MATERIALIZED (
    -- The page's visits, by the session that starts each: no earlier kept session of the same
    -- supervisor on the same call is open, or ended within the gap, when it starts. Walked newest
    -- first from the cursor on idx_agency_listen_sessions_account_started (0049), each probed on
    -- its call (idx_agency_listen_sessions_call), and cut at the page.
    SELECT ls.id, ls.listener_user_id, ls.call_id
      FROM agency_listen_sessions ls
     WHERE ${keptBy('ls')}
       AND ($8::timestamptz IS NULL OR (ls.started_at, ls.id) < ($8::timestamptz, $10::uuid))
       AND NOT EXISTS (
         SELECT 1 FROM agency_listen_sessions e
          WHERE e.call_id = ls.call_id AND e.listener_user_id = ls.listener_user_id
            AND ${keptBy('e')}
            AND (e.started_at, e.id) < (ls.started_at, ls.id)
            AND (e.ended_at IS NULL OR ls.started_at <= e.ended_at + make_interval(secs => $7::double precision / 1000)))
     ORDER BY ls.started_at DESC, ls.id DESC
     LIMIT $9
  ), s AS (
    -- Every kept session of those supervisors on those calls: the visits' members (one call's
    -- sessions, a handful), merged below exactly as before.
    SELECT ls.*,
           max(ls.ended_at) OVER earlier AS earlier_ended_at,
           bool_or(ls.ended_at IS NULL) OVER earlier AS earlier_open,
           count(*) OVER earlier AS earlier_count
      FROM agency_listen_sessions ls
     WHERE ${keptBy('ls')}
       AND ls.call_id IN (SELECT st.call_id FROM starts st)
       AND (ls.listener_user_id, ls.call_id) IN (SELECT st.listener_user_id, st.call_id FROM starts st)
    WINDOW earlier AS (PARTITION BY ls.listener_user_id, ls.call_id ORDER BY ls.started_at, ls.id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ), marked AS (
    SELECT s.*,
           CASE WHEN s.earlier_count = 0 THEN 1
                WHEN s.earlier_open THEN 0
                WHEN s.started_at <= s.earlier_ended_at + make_interval(secs => $7::double precision / 1000) THEN 0
                ELSE 1 END AS starts_visit
      FROM s
  ), numbered AS (
    SELECT m.*,
           sum(m.starts_visit) OVER (PARTITION BY m.listener_user_id, m.call_id ORDER BY m.started_at, m.id) AS visit_no,
           -- This session's share of the visit's time: from where the earlier ones ended.
           CASE WHEN m.ended_at IS NULL THEN NULL
                ELSE GREATEST(0, EXTRACT(EPOCH FROM m.ended_at - GREATEST(m.started_at, COALESCE(m.earlier_ended_at, m.started_at))))
                END AS share_seconds
      FROM marked m
  ), visits AS (
    SELECT n.listener_user_id, n.call_id, n.visit_no,
           array_agg(n.id ORDER BY n.started_at, n.id) AS listen_ids,
           min(n.started_at) AS started_at,
           bool_or(n.ended_at IS NULL) AS open,
           max(n.ended_at) AS last_ended_at,
           sum(n.share_seconds) AS listened_seconds,
           (array_agg(n.end_reason ORDER BY n.ended_at DESC, n.id DESC))[1] AS last_end_reason
      FROM numbered n
     GROUP BY n.listener_user_id, n.call_id, n.visit_no
  ), page AS (
    -- A visit is its first session's (the one that starts it, listen_ids[1]): its id, and the
    -- call's facts from that row.
    SELECT v.*, f.id, f.origin, f.correlation_id, f.campaign_id, f.agent_user_id
      FROM visits v
      JOIN starts st ON st.id = v.listen_ids[1]
      JOIN s f ON f.id = st.id
  )
  SELECT p.id, p.listen_ids, p.call_id, p.origin, p.correlation_id, p.campaign_id,
         cam.name AS campaign_name, r.name AS inbound_route_name,
         p.listener_user_id, p.agent_user_id,
         c.destination_phone AS customer_phone,
         ${contactNameContextSql('ct')} AS contact_context,
         p.started_at, ${keysetAtSql('p.started_at')} AS started_at_key,
         CASE WHEN p.open THEN NULL ELSE p.last_ended_at END AS ended_at,
         CASE WHEN p.open THEN NULL ELSE p.listened_seconds::text END AS listened_seconds,
         CASE WHEN p.open THEN NULL ELSE p.last_end_reason END AS end_reason
    FROM page p
    LEFT JOIN agency_calls c ON c.id = p.call_id AND c.tenant_id = $1::uuid
    LEFT JOIN agency_campaigns cam ON cam.id = p.campaign_id AND cam.tenant_id = $1::uuid
    LEFT JOIN agency_inbound_calls ic ON p.origin = 'inbound' AND ic.id = p.correlation_id AND ic.tenant_id = $1::uuid
    LEFT JOIN agency_inbound_routes r ON r.id = ic.route_id AND r.tenant_id = $1::uuid
    LEFT JOIN agency_call_attempts a ON p.origin = 'campaign' AND a.id = p.correlation_id AND a.tenant_id = $1::uuid
    LEFT JOIN agency_manual_calls mc ON p.origin = 'manual' AND mc.id = p.correlation_id AND mc.tenant_id = $1::uuid
    LEFT JOIN agency_contacts ct ON ct.id = COALESCE(a.contact_id, mc.contact_id, ic.matched_contact_id) AND ct.tenant_id = $1::uuid
   ORDER BY p.started_at DESC, p.id DESC`;

export class AgencyListenHistoryRepository {
  /**
   * One page of visits, newest first, and whether more follow (`limit + 1` read ahead; the extra
   * row is dropped).
   */
  async listVisits(q: ListenHistoryQuery): Promise<{ rows: ListenHistoryVisitRow[]; hasMore: boolean }> {
    const { rows } = await getPool().query<ListenHistoryVisitRow>(LISTEN_HISTORY_SQL, [
      q.tenantId, q.accountId, q.listenerUserId ?? null, q.agentUserId ?? null,
      q.from ?? null, q.to ?? null, Math.max(0, q.mergeGapMs),
      q.before?.at ?? null, q.limit + 1, q.before?.id ?? null,
    ]);
    const hasMore = rows.length > q.limit;
    return { rows: hasMore ? rows.slice(0, q.limit) : rows, hasMore };
  }
}

export const agencyListenHistoryRepository = new AgencyListenHistoryRepository();
