/**
 * `AgencyListenSessionRepository`: `agency_listen_sessions` (`0047_listen_sessions.sql`; live call
 * listening, docs/listening.md), one row per listen session: a supervisor listening in silently to
 * a call in progress. The listen registry (`agency/listen/`) opens and closes rows in the process
 * that owns the call; the live list reads the open ones for its listeners and caps, and the call
 * detail pages read a call's rows for "Listened to by".
 *
 * ── The row is the record ───────────────────────────────────────────────────
 * {@link AgencyListenSessionRepository.open} is awaited before any audio flows: a session whose
 * row could not be written is refused (no row, no audio, LS7). The audit pair goes through the
 * buffered writer and may lose rows on a crash; this table does not.
 *
 * ── Every row ends exactly once ─────────────────────────────────────────────
 * {@link AgencyListenSessionRepository.close} writes only an open row, so a second close (the
 * socket's close racing the call's end) changes nothing and answers null. A row left open by a
 * process that died is closed `server_restarted` by its replica: by the primary when it reaps a
 * dead media worker ({@link AgencyListenSessionRepository.closeOrphans}), and at boot for every
 * process no longer running ({@link AgencyListenSessionRepository.closeOrphansExcept}).
 *
 * Reads are scoped to the tenant (and the account where the caller names one); ids are validated
 * at the edge (a non-UUID reaching a `uuid` cast is `22P02`). The retention sweep at the audit
 * log's horizon is `audit/audit-partition-maintenance.ts`'s, not here.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyCallOrigin, AgencyListenEndReason } from '@magick-agency/contracts/agency';

/** An `agency_listen_sessions` row (`SELECT *`). */
export interface ListenSessionRecord {
  /** The listen id, minted with the grant. */
  id: string;
  tenant_id: string;
  account_id: string;
  /** `agency_calls.id`; no foreign key. */
  call_id: string;
  origin: AgencyCallOrigin;
  /** Always set for a dialler call (`ck_agency_listen_sessions_campaign`). */
  campaign_id: string | null;
  /** The call's spine row: the attempt, the manual call or the inbound call. */
  correlation_id: string;
  agent_session_id: string;
  agent_user_id: string;
  listener_user_id: string;
  started_at: Date;
  /** Both or neither (`ck_agency_listen_sessions_ended`). */
  ended_at: Date | null;
  end_reason: AgencyListenEndReason | null;
  /** 20 ms frames sent to the listener, both legs; written at the close. */
  frames_sent: number;
  /** Frames dropped under the listener's back-pressure; written at the close. */
  frames_dropped: number;
  /** The process that owns the call and the session (`AgencyRuntime.replicaId`). */
  replica_id: string;
}

/** A session to open: the listener socket attached and the grant consumed. */
export interface ListenSessionOpenInput {
  /** The grant's listen id. */
  id: string;
  tenantId: string;
  accountId: string;
  callId: string;
  origin: AgencyCallOrigin;
  campaignId: string | null;
  correlationId: string;
  agentSessionId: string;
  agentUserId: string;
  listenerUserId: string;
  replicaId: string;
}

/** How a session ended, and what it carried. */
export interface ListenSessionCloseInput {
  reason: AgencyListenEndReason;
  framesSent: number;
  framesDropped: number;
}

/** The columns `open` writes, spelled once beside its values (the rest take their defaults). */
const OPEN_COLUMNS = [
  'id', 'tenant_id', 'account_id', 'call_id', 'origin', 'campaign_id', 'correlation_id',
  'agent_session_id', 'agent_user_id', 'listener_user_id', 'replica_id',
] as const;

export class AgencyListenSessionRepository {
  /**
   * Write the session's row (`started_at` now, open). Throws on any failure, including a listen id
   * that already has a row (`23505`): the caller refuses the socket (`listen_unavailable`).
   */
  async open(input: ListenSessionOpenInput): Promise<ListenSessionRecord> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `INSERT INTO agency_listen_sessions (${OPEN_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [input.id, input.tenantId, input.accountId, input.callId, input.origin, input.campaignId, input.correlationId,
        input.agentSessionId, input.agentUserId, input.listenerUserId, input.replicaId],
    );
    return rows[0]!;
  }

  /**
   * End an open session: its end, why, and its counters. Null when the row is already closed (or
   * does not exist), so the first close wins and a second changes nothing.
   */
  async close(id: string, input: ListenSessionCloseInput): Promise<ListenSessionRecord | null> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `UPDATE agency_listen_sessions
          SET ended_at = GREATEST(now(), started_at),
              end_reason = $2::varchar,
              frames_sent = $3::integer,
              frames_dropped = $4::integer
        WHERE id = $1 AND ended_at IS NULL
        RETURNING *`,
      [id, input.reason, Math.max(0, Math.trunc(input.framesSent)), Math.max(0, Math.trunc(input.framesDropped))],
    );
    return rows[0] ?? null;
  }

  /** The account's open sessions, earliest first: the live list's listeners and the per-call cap. */
  async listOpenInAccount(tenantId: string, accountId: string): Promise<ListenSessionRecord[]> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `SELECT * FROM agency_listen_sessions
        WHERE tenant_id = $1 AND account_id = $2 AND ended_at IS NULL
        ORDER BY started_at, id`,
      [tenantId, accountId],
    );
    return rows;
  }

  /** The open sessions on these calls of the tenant, earliest first. No calls, no query. */
  async listOpenForCalls(tenantId: string, callIds: readonly string[]): Promise<ListenSessionRecord[]> {
    if (callIds.length === 0) return [];
    const { rows } = await getPool().query<ListenSessionRecord>(
      `SELECT * FROM agency_listen_sessions
        WHERE call_id = ANY($2::uuid[]) AND tenant_id = $1 AND ended_at IS NULL
        ORDER BY started_at, id`,
      [tenantId, callIds],
    );
    return rows;
  }

  /** Every session on one call of the account, open or closed, earliest first: "Listened to by". */
  async listForCall(tenantId: string, accountId: string, callId: string): Promise<ListenSessionRecord[]> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `SELECT * FROM agency_listen_sessions
        WHERE call_id = $3 AND tenant_id = $1 AND account_id = $2
        ORDER BY started_at, id`,
      [tenantId, accountId, callId],
    );
    return rows;
  }

  /**
   * One supervisor's open sessions in the tenant, newest first: what a role change or a removal
   * has to end (`permission_revoked`), and the one-listen-per-supervisor rule's lookup.
   */
  async listOpenForListener(tenantId: string, listenerUserId: string): Promise<ListenSessionRecord[]> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `SELECT * FROM agency_listen_sessions
        WHERE tenant_id = $1 AND listener_user_id = $2 AND ended_at IS NULL
        ORDER BY started_at DESC, id`,
      [tenantId, listenerUserId],
    );
    return rows;
  }

  /**
   * Close every session a dead process left open (`server_restarted`; the counters stay as they
   * were, unknown): the primary's reap of a media worker that exited. Answers the rows closed.
   */
  async closeOrphans(replicaId: string): Promise<ListenSessionRecord[]> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `UPDATE agency_listen_sessions
          SET ended_at = GREATEST(now(), started_at), end_reason = 'server_restarted'
        WHERE ended_at IS NULL AND replica_id = $1
        RETURNING *`,
      [replicaId],
    );
    return rows;
  }

  /**
   * Close every open session whose process is not one of `liveReplicaIds` (`server_restarted`): at
   * boot, before any listener can attach, with the ids of the processes running now (none yet on a
   * fresh primary, so every open row is an orphan). Answers the rows closed.
   */
  async closeOrphansExcept(liveReplicaIds: readonly string[]): Promise<ListenSessionRecord[]> {
    const { rows } = await getPool().query<ListenSessionRecord>(
      `UPDATE agency_listen_sessions
          SET ended_at = GREATEST(now(), started_at), end_reason = 'server_restarted'
        WHERE ended_at IS NULL AND NOT (replica_id = ANY($1::varchar[]))
        RETURNING *`,
      [liveReplicaIds],
    );
    return rows;
  }
}

export const agencyListenSessionRepository = new AgencyListenSessionRepository();
