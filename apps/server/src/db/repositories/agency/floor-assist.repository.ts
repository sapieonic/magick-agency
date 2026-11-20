/**
 * `AgencyFloorAssistRepository`: the Live floor's floor assist (Phase 3; decisions LF4, LF5, LF11
 * onwards; `0052_floor_assist.sql`). Two things:
 *
 *  - **Need help** on the agent's session row (`help_raised_at`, `help_call_id`,
 *    `help_answered_at`, `help_answered_by`, and from 0059 `help_state`, the agent's state at the
 *    raise: agent station BE-9). `help_state` is written by the raise and cleared in every statement
 *    that clears `help_raised_at` (`ck_agency_agent_sessions_help_state` refuses a state on a
 *    request that is not raised); an answer keeps both. A request is OPEN while raised, not answered and
 *    raised less than the expiry ago (`AGENCY_HELP_EXPIRY_MS`, passed in as `expiryMs` so a test can
 *    shorten it). Every transition is ONE statement, so two at once (an answer and the sweep, a
 *    cancel and a leave) end a request exactly once: the second waits on the row lock and, under
 *    READ COMMITTED, re-reads the row and matches nothing. A transition on one session (raise,
 *    cancel, answer, the session ending) that finds its request past the expiry expires it in that
 *    same statement and says so (`expired`), so an expired request is never overwritten or answered,
 *    and is ended once, by whichever statement reaches it first. The caller writes the audit row,
 *    the metric and the frame only for a row a transition returned (`agency/floor-assist.ts`).
 *    Expiry is relative to the database's `now()` everywhere, so a raise, the floor and the sweep
 *    never disagree on the clock.
 *  - **Messages** (`agency_supervisor_messages`): the insert, and the mark that a station took it.
 *    Their 90-day purge is the retention purge's (`maintenance/retention-purge.ts`).
 *
 * Every transition must answer the request as it found it, which `UPDATE … RETURNING` cannot (it
 * returns the new row), so each picks first: `WITH prior AS MATERIALIZED (SELECT … FOR UPDATE)`
 * (packages/db/CLAUDE.md's claim shape), then updates the picked row and returns the picked values,
 * with whether the request was past the expiry. The sweep skips a row another transaction holds
 * (`SKIP LOCKED`; the next sweep sees it again if it is still due); a single session's transition
 * waits for it.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import { HELP_OPEN_SQL as OPEN, helpOpenSql } from './sql-fragments.js';

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
  /** The agent's state when it was raised (0059); null on a request raised before it was recorded. */
  state: AgencyAgentState | null;
}

/**
 * A request a transition on one session ended, as it was: by the transition itself or, when it was
 * found past the expiry (`expired`), by the expiry (the caller audits it as expired).
 */
export interface HelpClearedRow extends HelpEndedRow {
  expired: boolean;
}

/** What {@link AgencyFloorAssistRepository.answer} found: a request it answered, or one past the expiry it expired. */
export type HelpAnswerResult =
  | (HelpEndedRow & { expired: false; answered_at: Date })
  | (HelpEndedRow & { expired: true });

/** An open request, as the floor and the station read it. */
export interface OpenHelpRow {
  session_id: string;
  raised_at: Date;
  call_id: string | null;
  /** The agent's state when it was raised (BE-9, 0059); null on a request raised before it was recorded. */
  state: AgencyAgentState | null;
}

/** What {@link AgencyFloorAssistRepository.raise} did. */
export type HelpRaiseResult = (
  /** Raised now. */
  | { raised: true; help: OpenHelpRow }
  /** One was open already: it is answered unchanged. */
  | { raised: false; help: OpenHelpRow }
  /** Nothing was raised and nothing is open: the session has left (or is not in this account). */
  | { raised: false; help: null }
) & {
  /** The request the raise found past the expiry, expired before this one was raised, as it was; else null. */
  expired: HelpEndedRow | null;
};

export interface SupervisorMessageInsert {
  tenantId: string;
  accountId: string;
  sessionId: string;
  agentUserId: string;
  senderUserId: string;
  /** Already trimmed and checked (1 to 500 characters); the CHECK refuses anything else. */
  text: string;
}

/** What every transition answers: the updated row `s`, and the request as `prior` picked it. */
const ENDED_COLUMNS = `s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
            prior.help_raised_at AS raised_at, prior.help_call_id AS call_id, prior.help_state AS state, prior.expired`;

/**
 * Clear the requests `where` picks (`$1` is the expiry in ms): `help_raised_at`, `help_call_id` and
 * `help_state` NULL (the state goes with the raise: 0059's CHECK refuses one left behind),
 * answering what each held and whether it was past the expiry. `limit` bounds a sweep's
 * batch; `skipLocked` for the sweep only.
 */
function clearSql(where: string, opts: { limit?: string; skipLocked?: boolean } = {}): string {
  return `
    WITH prior AS MATERIALIZED (
      SELECT id, help_raised_at, help_call_id, help_state, ${expired('$1')} AS expired
        FROM agency_agent_sessions
       WHERE ${where}
       ORDER BY help_raised_at, id
       ${opts.limit ? `LIMIT ${opts.limit}` : ''}
       FOR UPDATE${opts.skipLocked ? ' SKIP LOCKED' : ''}
    )
    UPDATE agency_agent_sessions s
       SET help_raised_at = NULL, help_call_id = NULL, help_state = NULL
      FROM prior
     WHERE s.id = prior.id
    RETURNING ${ENDED_COLUMNS}`;
}

/** The sweep's batch: the expired requests, oldest first, at most `$2`, skipping rows another transaction holds. Exported for its plan test. */
export const SWEEP_EXPIRED_SQL = clearSql(`${OPEN} AND ${expired('$1')}`, { limit: '$2', skipLocked: true });

/** The agent's cancel: `$2` session, `$3` tenant; its open request, expired instead when past the expiry. */
const CANCEL_SQL = clearSql(`id = $2::uuid AND tenant_id = $3::uuid AND ${OPEN}`);

/** The session ended: `$2` session; its open request, expired instead when past the expiry. */
const END_WITH_SESSION_SQL = clearSql(`id = $2::uuid AND ${OPEN}`);

/**
 * A supervisor (`$3`) answers the open request of session `$1` (tenant `$2`): it stays raised, now
 * answered (its `help_state` kept with it); or, past the expiry (`$4` ms), it is expired instead,
 * cleared as {@link clearSql} clears (the state with it).
 *
 * Answered at `GREATEST(now(), help_raised_at)`, never `now()` alone: `now()` is the answering
 * transaction's start, and an answer that waited on the row lock re-reads the row as the holder left
 * it. When that holder was a raise begun later (the agent raising again over a request past the
 * expiry, unswept), the answer finds a fresh open request raised after its own `now()`; it answers
 * that one, at the moment it was raised, never before it (`ck_agency_agent_sessions_help`).
 */
const ANSWER_SQL = `
  WITH prior AS MATERIALIZED (
    SELECT id, help_raised_at, help_call_id, help_state, ${expired('$4')} AS expired
      FROM agency_agent_sessions
     WHERE id = $1::uuid AND tenant_id = $2::uuid AND ${OPEN}
     FOR UPDATE
  )
  UPDATE agency_agent_sessions s
     SET help_answered_at = CASE WHEN prior.expired THEN s.help_answered_at ELSE GREATEST(now(), s.help_raised_at) END,
         help_answered_by = CASE WHEN prior.expired THEN s.help_answered_by ELSE $3::uuid END,
         help_raised_at = CASE WHEN prior.expired THEN NULL ELSE s.help_raised_at END,
         help_call_id = CASE WHEN prior.expired THEN NULL ELSE s.help_call_id END,
         help_state = CASE WHEN prior.expired THEN NULL ELSE s.help_state END
    FROM prior
   WHERE s.id = prior.id
  RETURNING ${ENDED_COLUMNS}, s.help_answered_at AS answered_at`;

/**
 * Raise a request (call `$4`, the agent's state `$6`, BE-9) on session `$1` (tenant `$2`, account
 * `$3`, not left) unless one is open (`$5` the expiry in ms). One open and fresh: left as it is and answered (`raised_at` null).
 * One open past the expiry, or none open (never raised, cleared, or answered): raised now, the
 * expired one answered as it was (`prior_*` with `expired`). No row: the session has left (or is
 * not in this account).
 */
const RAISE_SQL = `
  WITH prior AS MATERIALIZED (
    SELECT id, tenant_id, account_id, campaign_id, agent_user_id, help_raised_at, help_call_id, help_state,
           (${OPEN}) AS open, (${OPEN} AND ${expired('$5')}) AS expired
      FROM agency_agent_sessions
     WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND left_at IS NULL
     FOR UPDATE
  ), raised AS (
    UPDATE agency_agent_sessions s
       SET help_raised_at = now(), help_call_id = $4::uuid, help_state = $6::varchar,
           help_answered_at = NULL, help_answered_by = NULL
      FROM prior
     WHERE s.id = prior.id AND NOT (prior.open AND NOT prior.expired)
    RETURNING s.help_raised_at, s.help_call_id, s.help_state
  )
  SELECT prior.id AS session_id, prior.tenant_id, prior.account_id, prior.campaign_id, prior.agent_user_id,
         prior.expired, prior.help_raised_at AS prior_raised_at, prior.help_call_id AS prior_call_id,
         prior.help_state AS prior_state,
         raised.help_raised_at AS raised_at, raised.help_call_id AS call_id, raised.help_state AS state
    FROM prior LEFT JOIN raised ON true`;

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
   * Raise a request on the session (`tenantId`, `accountId` its own, not left) unless one is open,
   * in one statement ({@link RAISE_SQL}): a request found past the expiry is expired by it and
   * answered in `expired`, never overwritten unaudited. `state` is the agent's state now (BE-9),
   * recorded on a request raised by this call; one already open keeps the state it was raised in.
   */
  async raise(input: {
    sessionId: string; tenantId: string; accountId: string; callId: string | null; state: AgencyAgentState; expiryMs: number;
  }): Promise<HelpRaiseResult> {
    const { rows } = await getPool().query<Omit<HelpEndedRow, 'raised_at' | 'call_id' | 'state'> & {
      expired: boolean; prior_raised_at: Date | null; prior_call_id: string | null; prior_state: AgencyAgentState | null;
      raised_at: Date | null; call_id: string | null; state: AgencyAgentState | null;
    }>(RAISE_SQL, [input.sessionId, input.tenantId, input.accountId, input.callId, input.expiryMs, input.state]);
    const r = rows[0];
    if (!r) return { raised: false, help: null, expired: null };
    const { session_id, tenant_id, account_id, campaign_id, agent_user_id } = r;
    const expired: HelpEndedRow | null = r.expired
      ? {
        session_id, tenant_id, account_id, campaign_id, agent_user_id,
        raised_at: r.prior_raised_at!, call_id: r.prior_call_id, state: r.prior_state,
      }
      : null;
    return r.raised_at
      ? { raised: true, help: { session_id, raised_at: r.raised_at, call_id: r.call_id, state: r.state }, expired }
      : { raised: false, help: { session_id, raised_at: r.prior_raised_at!, call_id: r.prior_call_id, state: r.prior_state }, expired };
  }

  /** The session's open request, or null. */
  async openForSession(sessionId: string, tenantId: string, accountId: string, expiryMs: number): Promise<OpenHelpRow | null> {
    const { rows } = await getPool().query<OpenHelpRow>(
      `SELECT id AS session_id, help_raised_at AS raised_at, help_call_id AS call_id, help_state AS state
         FROM agency_agent_sessions
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND left_at IS NULL
          AND ${helpOpenSql('$4')}`,
      [sessionId, tenantId, accountId, expiryMs],
    );
    return rows[0] ?? null;
  }

  /**
   * The agent cancels: the session's open request, or null when none was open. `expired`: it was
   * past the expiry, so it was expired, not cancelled.
   */
  async cancel(sessionId: string, tenantId: string, expiryMs: number): Promise<HelpClearedRow | null> {
    const { rows } = await getPool().query<HelpClearedRow>(CANCEL_SQL, [expiryMs, sessionId, tenantId]);
    return rows[0] ?? null;
  }

  /** The session ended: its open request, or null. `expired`: it was past the expiry, so it was expired. */
  async endWithSession(sessionId: string, expiryMs: number): Promise<HelpClearedRow | null> {
    const { rows } = await getPool().query<HelpClearedRow>(END_WITH_SESSION_SQL, [expiryMs, sessionId]);
    return rows[0] ?? null;
  }

  /**
   * A supervisor (`byUserId`) answered the session's open request: it stays raised, now answered.
   * `expired`: it was past the expiry, so it was expired instead. Null when none was open (none
   * raised, already answered, or cleared).
   */
  async answer(sessionId: string, tenantId: string, byUserId: string, expiryMs: number): Promise<HelpAnswerResult | null> {
    const { rows } = await getPool().query<HelpAnswerResult>(ANSWER_SQL, [sessionId, tenantId, byUserId, expiryMs]);
    return rows[0] ?? null;
  }

  /**
   * The sweep: expire every request left unanswered past the expiry, in batches of
   * {@link HELP_SWEEP_BATCH} (skipping rows another transaction holds) until a batch comes back
   * short. Each row is returned once, by the one statement that cleared it.
   */
  async expireDue(expiryMs: number): Promise<HelpEndedRow[]> {
    const out: HelpEndedRow[] = [];
    for (;;) {
      const { rows } = await getPool().query<HelpClearedRow>(SWEEP_EXPIRED_SQL, [expiryMs, HELP_SWEEP_BATCH]);
      for (const { expired: _expired, ...row } of rows) out.push(row);
      if (rows.length < HELP_SWEEP_BATCH) return out;
    }
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
