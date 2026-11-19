/**
 * `AgencyFloorAssistRepository`: the Live floor's floor assist (Phase 3; decisions LF4, LF5, LF11
 * onwards; `0052_floor_assist.sql`). Two things:
 *
 *  - **Need help** on the agent's session row (`help_raised_at`, `help_call_id`,
 *    `help_answered_at`, `help_answered_by`). A request is OPEN while raised, not answered and
 *    raised less than the expiry ago (`AGENCY_HELP_EXPIRY_MS`, passed in as `expiryMs` so a test can
 *    shorten it). Every transition is ONE conditional statement whose `WHERE` is the state it leaves,
 *    so two at once (an answer and the sweep, a cancel and a leave) end a request exactly once: the
 *    second waits on the row lock and, under READ COMMITTED, re-reads the row and matches nothing.
 *    The caller writes the audit row, the metric and the frame only for a row a transition returned
 *    (`agency/floor-assist.ts`). Expiry is relative to the database's `now()` everywhere, so a raise,
 *    the floor and the sweep never disagree on the clock.
 *  - **Messages** (`agency_supervisor_messages`): the insert, and the mark that a station took it.
 *    Their 90-day purge is the retention purge's (`maintenance/retention-purge.ts`).
 *
 * The clearing transitions (cancel, expiry, the session ending) set `help_raised_at` and
 * `help_call_id` NULL and must answer what they cleared, which `UPDATE … RETURNING` cannot (it
 * returns the new row), so they pick first: `WITH target AS MATERIALIZED (SELECT … FOR UPDATE)`
 * (packages/db/CLAUDE.md's claim shape), then update the picked rows and return the picked values.
 * The sweep skips a row another transaction holds (`SKIP LOCKED`; the next sweep sees it again if
 * it is still due); a single session's transition waits for it.
 */
import { getPool } from '@magick-agency/db';

/** Open: raised and not answered. */
const OPEN = 'help_raised_at IS NOT NULL AND help_answered_at IS NULL';

/** Raised less than `$n` ms ago. */
const fresh = (param: string) => `help_raised_at > now() - ${param}::bigint * interval '1 millisecond'`;

/** Raised `$n` ms ago or more: expired. */
const expired = (param: string) => `help_raised_at <= now() - ${param}::bigint * interval '1 millisecond'`;

/** A request a transition ended, as it was. */
export interface HelpEndedRow {
  session_id: string;
  tenant_id: string;
  account_id: string;
  /** Null for a soft-phone session. */
  campaign_id: string | null;
  agent_user_id: string;
  raised_at: Date;
  call_id: string | null;
}

/** A request a supervisor answered. */
export interface HelpAnsweredRow extends HelpEndedRow {
  answered_at: Date;
}

/** An open request, as the floor and the station read it. */
export interface OpenHelpRow {
  session_id: string;
  raised_at: Date;
  call_id: string | null;
}

/** What {@link AgencyFloorAssistRepository.raise} did. */
export type HelpRaiseResult =
  /** Raised now. */
  | { raised: true; help: OpenHelpRow }
  /** One was open already: it is answered unchanged. */
  | { raised: false; help: OpenHelpRow }
  /** Nothing was raised and nothing is open: the session has left (or is not in this account). */
  | { raised: false; help: null };

export interface SupervisorMessageInsert {
  tenantId: string;
  accountId: string;
  sessionId: string;
  agentUserId: string;
  senderUserId: string;
  /** Already trimmed and checked (1 to 500 characters); the CHECK refuses anything else. */
  text: string;
}

/**
 * Clear the requests `where` picks (`$1` is the expiry in ms): `help_raised_at` and `help_call_id`
 * NULL, answering what each held. `limit` bounds a sweep's batch; `skipLocked` for the sweep only.
 */
function clearSql(where: string, opts: { limit?: string; skipLocked?: boolean } = {}): string {
  return `
    WITH target AS MATERIALIZED (
      SELECT id, help_raised_at, help_call_id
        FROM agency_agent_sessions
       WHERE ${where}
       ORDER BY help_raised_at, id
       ${opts.limit ? `LIMIT ${opts.limit}` : ''}
       FOR UPDATE${opts.skipLocked ? ' SKIP LOCKED' : ''}
    )
    UPDATE agency_agent_sessions s
       SET help_raised_at = NULL, help_call_id = NULL
      FROM target
     WHERE s.id = target.id
    RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
              target.help_raised_at AS raised_at, target.help_call_id AS call_id`;
}

/** The expired requests, oldest first, at most `$2`: the sweep (and the raise's own first step, `$3` one session). Exported for its plan test. */
export const EXPIRE_DUE_SQL = clearSql(`${OPEN} AND ${expired('$1')} AND ($3::uuid IS NULL OR id = $3::uuid)`, { limit: '$2', skipLocked: false });

/** The sweep's batch: as {@link EXPIRE_DUE_SQL}, skipping rows another transaction holds. Exported for its plan test. */
export const SWEEP_EXPIRED_SQL = clearSql(`${OPEN} AND ${expired('$1')}`, { limit: '$2', skipLocked: true });

/** The agent's cancel: `$2` session, `$3` tenant; only an open request (an expired one is the expiry's). */
const CANCEL_SQL = clearSql(`id = $2::uuid AND tenant_id = $3::uuid AND ${OPEN} AND ${fresh('$1')}`);

/** The session ended: `$2` session; only an open request (an expired one is the expiry's). */
const END_WITH_SESSION_SQL = clearSql(`id = $2::uuid AND ${OPEN} AND ${fresh('$1')}`);

/** An account's open requests on open sessions: the floor read. `$3` the expiry in ms. Exported for its plan test. */
export const OPEN_HELP_FOR_ACCOUNT_SQL = `
  SELECT id AS session_id, help_raised_at AS raised_at, help_call_id AS call_id
    FROM agency_agent_sessions
   WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND left_at IS NULL
     AND ${OPEN} AND ${fresh('$3')}`;

/**
 * The call the session is connected to now (`agency_calls.id`), on any spine: a bridged campaign
 * attempt the session holds, its bridged soft-phone call, or its connected inbound call; the most
 * recently connected should there be two. `$1` session, `$2` tenant. Each arm reads its spine's
 * index of a session's live rows (`idx_agency_attempts_agent`, `uq_agency_manual_call_unsettled`,
 * `uq_agency_inbound_calls_session_unsettled`). Exported for its plan test.
 */
export const LIVE_CALL_FOR_SESSION_SQL = `
  SELECT call_id FROM (
    SELECT a.webrtc_call_id AS call_id, a.bridged_at AS connected_at
      FROM agency_call_attempts a
     WHERE a.reserved_agent_id = $1::uuid AND a.tenant_id = $2::uuid
       AND a.state <> 'ended' AND a.state = 'bridged' AND a.webrtc_call_id IS NOT NULL
    UNION ALL
    SELECT m.webrtc_call_id, m.bridged_at
      FROM agency_manual_calls m
     WHERE m.session_id = $1::uuid AND m.tenant_id = $2::uuid
       AND m.settled_at IS NULL AND m.state = 'bridged' AND m.webrtc_call_id IS NOT NULL
    UNION ALL
    SELECT i.webrtc_call_id, i.bridged_at
      FROM agency_inbound_calls i
     WHERE i.session_id = $1::uuid AND i.tenant_id = $2::uuid
       AND i.settled_at IS NULL AND i.state = 'connected' AND i.bridged_at IS NOT NULL AND i.webrtc_call_id IS NOT NULL
  ) live
  ORDER BY connected_at DESC NULLS LAST
  LIMIT 1`;

/** How many expired requests one sweep statement clears; the sweep repeats until fewer come back. */
export const HELP_SWEEP_BATCH = 200;

export class AgencyFloorAssistRepository {
  // ── Need help ──────────────────────────────────────────────────────────────

  /**
   * Raise a request on the session (`tenantId`, `accountId` its own, not left) unless one is open.
   * The caller expires a due request first ({@link expireDue} for the session), so an expired one
   * is never overwritten unaudited; a request found expired in between is expired here and the raise
   * tried again (at most twice more), its row in `expiredMeanwhile`.
   */
  async raise(input: {
    sessionId: string; tenantId: string; accountId: string; callId: string | null; expiryMs: number;
  }): Promise<HelpRaiseResult & { expiredMeanwhile: HelpEndedRow[] }> {
    const expiredMeanwhile: HelpEndedRow[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await getPool().query<{ raised_at: Date; call_id: string | null }>(
        `UPDATE agency_agent_sessions
            SET help_raised_at = now(), help_call_id = $4::uuid, help_answered_at = NULL, help_answered_by = NULL
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND left_at IS NULL
            AND NOT (${OPEN})
          RETURNING help_raised_at AS raised_at, help_call_id AS call_id`,
        [input.sessionId, input.tenantId, input.accountId, input.callId],
      );
      if (rows[0]) return { raised: true, help: { session_id: input.sessionId, ...rows[0] }, expiredMeanwhile };
      const open = await this.openForSession(input.sessionId, input.tenantId, input.accountId, input.expiryMs);
      if (open) return { raised: false, help: open, expiredMeanwhile };
      // Neither raised nor open: the session left, or its open request expired since the caller's
      // expiry pass. Expire that one (audited by the caller) and try again.
      const due = await this.expireDue(input.expiryMs, { sessionId: input.sessionId });
      if (due.length === 0) return { raised: false, help: null, expiredMeanwhile };
      expiredMeanwhile.push(...due);
    }
    return { raised: false, help: null, expiredMeanwhile };
  }

  /** The session's open request, or null. */
  async openForSession(sessionId: string, tenantId: string, accountId: string, expiryMs: number): Promise<OpenHelpRow | null> {
    const { rows } = await getPool().query<OpenHelpRow>(
      `SELECT id AS session_id, help_raised_at AS raised_at, help_call_id AS call_id
         FROM agency_agent_sessions
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND left_at IS NULL
          AND ${OPEN} AND ${fresh('$4')}`,
      [sessionId, tenantId, accountId, expiryMs],
    );
    return rows[0] ?? null;
  }

  /** The agent cancels: the session's open request, or null when none was open. */
  async cancel(sessionId: string, tenantId: string, expiryMs: number): Promise<HelpEndedRow | null> {
    const { rows } = await getPool().query<HelpEndedRow>(CANCEL_SQL, [expiryMs, sessionId, tenantId]);
    return rows[0] ?? null;
  }

  /** The session ended: its open request, or null. */
  async endWithSession(sessionId: string, expiryMs: number): Promise<HelpEndedRow | null> {
    const { rows } = await getPool().query<HelpEndedRow>(END_WITH_SESSION_SQL, [expiryMs, sessionId]);
    return rows[0] ?? null;
  }

  /**
   * A supervisor (`byUserId`) answered the session's open request: it stays raised, now answered.
   * Null when none was open (none raised, already answered, cleared, or expired).
   */
  async answer(sessionId: string, tenantId: string, byUserId: string, expiryMs: number): Promise<HelpAnsweredRow | null> {
    const { rows } = await getPool().query<HelpAnsweredRow>(
      `UPDATE agency_agent_sessions
          SET help_answered_at = now(), help_answered_by = $3::uuid
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND ${OPEN} AND ${fresh('$4')}
        RETURNING id AS session_id, tenant_id, account_id, campaign_id, agent_user_id,
                  help_raised_at AS raised_at, help_call_id AS call_id, help_answered_at AS answered_at`,
      [sessionId, tenantId, byUserId, expiryMs],
    );
    return rows[0] ?? null;
  }

  /**
   * Expire the requests left unanswered past the expiry: one session's (`sessionId`, waiting on a
   * row another transaction holds), or every session's, in batches of {@link HELP_SWEEP_BATCH}
   * (`sweep`, skipping held rows) until a batch comes back short. Each row is returned once, by the
   * one statement that cleared it.
   */
  async expireDue(expiryMs: number, opts: { sessionId?: string; sweep?: boolean } = {}): Promise<HelpEndedRow[]> {
    if (!opts.sweep) {
      const { rows } = await getPool().query<HelpEndedRow>(EXPIRE_DUE_SQL, [expiryMs, HELP_SWEEP_BATCH, opts.sessionId ?? null]);
      return rows;
    }
    const out: HelpEndedRow[] = [];
    for (;;) {
      const { rows } = await getPool().query<HelpEndedRow>(SWEEP_EXPIRED_SQL, [expiryMs, HELP_SWEEP_BATCH]);
      out.push(...rows);
      if (rows.length < HELP_SWEEP_BATCH) return out;
    }
  }

  /** The account's open requests on its open sessions (the floor read). */
  async openForAccount(tenantId: string, accountId: string, expiryMs: number): Promise<OpenHelpRow[]> {
    const { rows } = await getPool().query<OpenHelpRow>(OPEN_HELP_FOR_ACCOUNT_SQL, [tenantId, accountId, expiryMs]);
    return rows;
  }

  /** The call the session is connected to now (`agency_calls.id`), or null. */
  async liveCallIdForSession(sessionId: string, tenantId: string): Promise<string | null> {
    const { rows } = await getPool().query<{ call_id: string }>(LIVE_CALL_FOR_SESSION_SQL, [sessionId, tenantId]);
    return rows[0]?.call_id ?? null;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /** Store a message, not yet delivered. */
  async insertMessage(input: SupervisorMessageInsert): Promise<{ id: string; sent_at: Date }> {
    const { rows } = await getPool().query<{ id: string; sent_at: Date }>(
      `INSERT INTO agency_supervisor_messages (tenant_id, account_id, session_id, agent_user_id, sender_user_id, text)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sent_at`,
      [input.tenantId, input.accountId, input.sessionId, input.agentUserId, input.senderUserId, input.text],
    );
    return rows[0]!;
  }

  /** A station took the message. */
  async markDelivered(id: string): Promise<void> {
    await getPool().query('UPDATE agency_supervisor_messages SET delivered = true WHERE id = $1', [id]);
  }
}

export const agencyFloorAssistRepository = new AgencyFloorAssistRepository();
