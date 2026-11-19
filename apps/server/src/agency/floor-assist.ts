/**
 * Floor assist (the Live floor's Phase 3; decisions LF4, LF5, LF11 onwards; contracts
 * `agency/floor-assist.ts`): an agent's **Need help** on their own session, and a supervisor's
 * **message** to an agent's station.
 *
 * One service per process, in the runtime (`runtime.floorAssist`). Every Need help transition is one
 * conditional statement (`db/repositories/agency/floor-assist.repository.ts`), and this service acts
 * only on a row the statement returned, so for each request ended there is exactly one audit row,
 * one metric increment and one `help_cleared` frame, whoever ends it and however many try at once:
 *
 *  - **raise** (the agent, `POST /sessions/:id/help`): a request already open is answered unchanged
 *    (idempotent, no second audit row); one past the expiry is expired first (`expired`, audited),
 *    never overwritten.
 *  - **cancel** (the agent, `DELETE /sessions/:id/help`): `help_cleared { cancelled }`.
 *  - **answer**: a supervisor's listen on the agent's call going live (`listen`, the listener
 *    socket's `onListenLive`), or their message reaching the agent's station (`message`).
 *    `help_answered { by_name, how }` then `help_cleared { answered }`.
 *  - **expiry**: {@link AGENCY_HELP_EXPIRY_MS} after the raise. Every read treats an expired request
 *    as cleared (the floor's `help`, the station's `ready.help`), so nothing waits on the sweep for
 *    correctness; the sweep ({@link FloorAssistService.sweep}, every {@link HELP_SWEEP_INTERVAL_MS}
 *    in the primary) clears the columns, sends `help_cleared { expired }` and writes the audit row,
 *    up to one interval late. A raise, cancel, answer or end on a session expires that session's
 *    request first, so each of those sees the same state the floor shows.
 *  - **the session ending** (`leaveSession`): `help_cleared { session_ended }`, before the station is
 *    detached, so a console still attached hears it.
 *
 * Frames go through `send` (the station registry in one process; with media workers, in the primary,
 * the station directory, which hands a frame to the worker holding the station). A frame no station
 * took is not retried: the request's state is in the row, and the station's next `ready` reads it.
 * Audit rows, frames and metrics never fail the transition that caused them.
 *
 * **Messages** ({@link FloorAssistService.sendMessage}): run in the process holding the agent's
 * station (the route's owner is the session), which is the only place that knows whether a station
 * that can receive the frame is attached here. None: `agent_not_live`, nothing stored. One: the row
 * is written (`delivered` false), the frame sent, the row marked delivered, an open request answered
 * (`message`); a frame the socket refused in between leaves the row undelivered and answers
 * `agent_not_live`. One audit row per stored message, with whether it was delivered. Once the
 * socket took the frame the message HAS been delivered, so nothing after it fails the send: the
 * mark is tried twice and, failing both, logged and counted
 * (`agency_supervisor_message_mark_failures_total`), leaving a row that reads `delivered` false for
 * a message the agent was shown (the audit row's `delivered: true` is the record then); the metric,
 * the audit row and the help answer are each attempted whatever the others did.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  trackHelpCleared,
  trackHelpRaised,
  trackSupervisorMessage,
  trackSupervisorMessageMarkFailed,
} from '@magick-agency/observability/metrics/agency';
import {
  AGENCY_HELP_EXPIRY_MS,
  AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS,
  type AgencyFloorAssistErrorCode,
  type AgencyHelpAnswerHow,
  type AgencyHelpClearedReason,
  type AgencySessionHelp,
} from '@magick-agency/contracts/agency';
import type {
  AgencyFloorAssistRepository,
  HelpEndedRow,
  OpenHelpRow,
} from '../db/repositories/agency.repository.js';
import type { PlatformCreateAuditLogInput } from '../audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR, type AuditActorFields } from '../audit/platform/audit-actor.js';
import type { StationFrame } from './station-registry.js';

const log = createChildLogger({ component: 'agency-floor-assist' });

/** How often the primary's sweep clears expired Need help requests (frame and audit row). */
export const HELP_SWEEP_INTERVAL_MS = 15_000;

/** The session fields the service reads. */
export interface FloorAssistSession {
  id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string | null;
  agent_user_id: string;
}

export interface FloorAssistDeps {
  repo: Pick<AgencyFloorAssistRepository,
    'raise' | 'cancel' | 'answer' | 'endWithSession' | 'expireDue' | 'openForSession' | 'insertMessage' | 'markDelivered'>;
  /** Send a frame to the session's station wherever it is held; false when none took it. */
  send(sessionId: string, frame: StationFrame): boolean;
  /** Whether THIS process holds the session's station, open and able to receive the floor assist frames. */
  canReceive(sessionId: string): boolean;
  /** Display names by user id (`agentNamesOrNone`): a missing or null name is sent as null. */
  names(userIds: string[], tenantId: string): Promise<Map<string, string | null>>;
  audit(entry: PlatformCreateAuditLogInput): void;
  /** The expiry; {@link AGENCY_HELP_EXPIRY_MS} unless a test shortens it. */
  expiryMs?: number;
}

/** What a raise answers. */
export interface HelpRaiseOutcome {
  /** True when this call raised it; false when one was open already, or nothing could be raised. */
  raised: boolean;
  /** The open request, or null when the session has left. */
  help: AgencySessionHelp | null;
}

/** What a message send answers. */
export type SupervisorMessageOutcome =
  | { ok: true; id: string; sent_at: Date }
  | { ok: false; code: 'agent_not_live' };

/** The wire shape of an open request. */
export function toSessionHelp(row: Pick<OpenHelpRow, 'raised_at' | 'call_id'>): AgencySessionHelp {
  return { raised_at: new Date(row.raised_at).toISOString(), call_id: row.call_id };
}

type HelpAuditAction =
  | 'agency_session.help_raised'
  | 'agency_session.help_cancelled'
  | 'agency_session.help_answered'
  | 'agency_session.help_expired'
  | 'agency_session.help_session_ended';

const CLEARED_ACTION: Readonly<Record<Exclude<AgencyHelpClearedReason, 'answered'>, HelpAuditAction>> = {
  cancelled: 'agency_session.help_cancelled',
  expired: 'agency_session.help_expired',
  session_ended: 'agency_session.help_session_ended',
};

export class FloorAssistService {
  private readonly expiryMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<number> | null = null;

  constructor(private readonly deps: FloorAssistDeps) {
    this.expiryMs = deps.expiryMs ?? AGENCY_HELP_EXPIRY_MS;
  }

  // ── Need help ──────────────────────────────────────────────────────────────

  /** The agent raises a request on their own session (the route has checked it is theirs, live, on a call or in wrap-up). */
  async raise(session: FloorAssistSession, callId: string | null): Promise<HelpRaiseOutcome> {
    await this.expireSession(session.id);
    const result = await this.deps.repo.raise({
      sessionId: session.id, tenantId: session.tenant_id, accountId: session.account_id, callId, expiryMs: this.expiryMs,
    });
    for (const row of result.expiredMeanwhile) this.cleared(row, 'expired', SYSTEM_AUDIT_ACTOR);
    if (result.raised) {
      this.safely(() => trackHelpRaised());
      this.audit(session, 'agency_session.help_raised', { actor_type: 'human', user_id: session.agent_user_id }, {
        raised_at: new Date(result.help.raised_at).toISOString(),
        ...(result.help.call_id ? { call_id: result.help.call_id } : {}),
      });
      log.info({ sessionId: session.id, tenantId: session.tenant_id, callId: result.help.call_id }, 'Need help raised');
    }
    return { raised: result.raised, help: result.help ? toSessionHelp(result.help) : null };
  }

  /**
   * The session's open request as the station's `ready` carries it (`ready.help`, LF15), or null:
   * the repository's OPEN rule on the database's clock (LF12), never this process's. The station
   * attach reads it after its socket is registered, so a request cleared after this read has its
   * `help_cleared` sent to that socket (`StationRegistry.helpClearedOn`).
   */
  async openHelp(session: Pick<FloorAssistSession, 'id' | 'tenant_id' | 'account_id'>): Promise<AgencySessionHelp | null> {
    const row = await this.deps.repo.openForSession(session.id, session.tenant_id, session.account_id, this.expiryMs);
    return row ? toSessionHelp(row) : null;
  }

  /** The agent cancels their open request; false when none was open. */
  async cancel(session: FloorAssistSession): Promise<boolean> {
    await this.expireSession(session.id);
    const row = await this.deps.repo.cancel(session.id, session.tenant_id, this.expiryMs);
    if (!row) return false;
    this.cleared(row, 'cancelled', { actor_type: 'human', user_id: session.agent_user_id });
    return true;
  }

  /**
   * A supervisor answered the session's open request (`how`). False when none was open. Never
   * throws: an answer is a side effect of a listen or a message, which it must not fail.
   */
  async answer(input: { sessionId: string; tenantId: string; byUserId: string; how: AgencyHelpAnswerHow }): Promise<boolean> {
    try {
      await this.expireSession(input.sessionId);
      const row = await this.deps.repo.answer(input.sessionId, input.tenantId, input.byUserId, this.expiryMs);
      if (!row) return false;
      const raisedAt = new Date(row.raised_at);
      const seconds = (new Date(row.answered_at).getTime() - raisedAt.getTime()) / 1000;
      this.safely(() => trackHelpCleared('answered', seconds));
      this.audit(row, 'agency_session.help_answered', { actor_type: 'human', user_id: input.byUserId }, {
        raised_at: raisedAt.toISOString(), how: input.how, answered_by: input.byUserId,
        ...(row.call_id ? { call_id: row.call_id } : {}),
      });
      const byName = (await this.deps.names([input.byUserId], input.tenantId)).get(input.byUserId) ?? null;
      this.frame(row.session_id, { event: 'help_answered', raised_at: raisedAt.toISOString(), by_name: byName, how: input.how });
      this.frame(row.session_id, { event: 'help_cleared', raised_at: raisedAt.toISOString(), reason: 'answered' });
      log.info({ sessionId: row.session_id, how: input.how, seconds }, 'Need help answered');
      return true;
    } catch (err) {
      log.warn({ err, sessionId: input.sessionId, how: input.how }, 'Could not record a Need help answer');
      return false;
    }
  }

  /** The session ended (`leaveSession`). Never throws: a leave must not fail on it. */
  async endWithSession(sessionId: string): Promise<void> {
    try {
      await this.expireSession(sessionId);
      const row = await this.deps.repo.endWithSession(sessionId, this.expiryMs);
      if (row) this.cleared(row, 'session_ended', SYSTEM_AUDIT_ACTOR);
    } catch (err) {
      log.warn({ err, sessionId }, 'Could not clear the Need help of a session that ended; it expires on its own');
    }
  }

  /**
   * Expire every request left unanswered past the expiry, across the deployment: each one's
   * `help_cleared { expired }`, audit row and metric. Answers how many. Never throws; one pass at
   * a time (a call during a pass joins it).
   */
  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        const rows = await this.deps.repo.expireDue(this.expiryMs, { sweep: true });
        for (const row of rows) this.cleared(row, 'expired', SYSTEM_AUDIT_ACTOR);
        return rows.length;
      } catch (err) {
        log.warn({ err }, 'Need help expiry sweep failed; the next pass retries (the floor already reads them as expired)');
        return 0;
      } finally {
        this.sweeping = null;
      }
    })();
    return this.sweeping;
  }

  /** Run {@link sweep} every `intervalMs` until {@link stopSweep}. Idempotent. */
  startSweep(intervalMs: number = HELP_SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop the timer and wait for a pass in flight. */
  async stopSweep(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.sweeping) await this.sweeping;
  }

  isSweepArmed(): boolean {
    return this.sweepTimer !== null;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /**
   * A supervisor's message to the session's station. The route has checked the supervisor, the
   * account, the flag, the session (in the account, not left) and the text.
   */
  async sendMessage(input: {
    session: FloorAssistSession; senderUserId: string; fromName: string | null; text: string;
  }): Promise<SupervisorMessageOutcome> {
    const { session } = input;
    if (!this.deps.canReceive(session.id)) {
      this.safely(() => trackSupervisorMessage('agent_not_live'));
      return { ok: false, code: 'agent_not_live' };
    }
    const stored = await this.deps.repo.insertMessage({
      tenantId: session.tenant_id, accountId: session.account_id, sessionId: session.id,
      agentUserId: session.agent_user_id, senderUserId: input.senderUserId, text: input.text,
    });
    const sentAt = new Date(stored.sent_at);
    const delivered = this.deps.send(session.id, {
      event: 'supervisor_message', id: stored.id, text: input.text, from_name: input.fromName, sent_at: sentAt.toISOString(),
    });
    // Delivered: the agent has it. The mark, the metric, the audit row and the answer below are each
    // best effort and independent, so the supervisor is told it was delivered whatever fails.
    if (delivered) await this.markDelivered(stored.id, session.id);
    this.safely(() => trackSupervisorMessage(delivered ? 'delivered' : 'agent_not_live'));
    this.audit(session, 'agency_session.message_sent', { actor_type: 'human', user_id: input.senderUserId }, {
      message_id: stored.id, agent_user_id: session.agent_user_id, delivered, length: [...input.text].length,
    });
    if (!delivered) {
      log.info({ sessionId: session.id, messageId: stored.id }, 'Supervisor message not taken by the station; answered agent_not_live');
      return { ok: false, code: 'agent_not_live' };
    }
    await this.answer({ sessionId: session.id, tenantId: session.tenant_id, byUserId: input.senderUserId, how: 'message' });
    return { ok: true, id: stored.id, sent_at: sentAt };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Mark a delivered message's row, trying once more on a failure; never throws (LF17). */
  private async markDelivered(messageId: string, sessionId: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.deps.repo.markDelivered(messageId);
        return;
      } catch (err) {
        if (attempt === 2) {
          log.warn({ err, sessionId, messageId },
            'A message the station took could not be marked delivered; its row reads delivered = false (the audit row says delivered)');
          this.safely(() => trackSupervisorMessageMarkFailed());
        }
      }
    }
  }

  /** The session's request, if it is past the expiry: expired now (and audited) before anything else reads or changes it. */
  private async expireSession(sessionId: string): Promise<void> {
    const rows = await this.deps.repo.expireDue(this.expiryMs, { sessionId });
    for (const row of rows) this.cleared(row, 'expired', SYSTEM_AUDIT_ACTOR);
  }

  /** A request a clearing transition ended: metric, audit row, frame. */
  private cleared(row: HelpEndedRow, reason: Exclude<AgencyHelpClearedReason, 'answered'>, actor: AuditActorFields): void {
    const raisedAt = new Date(row.raised_at).toISOString();
    this.safely(() => trackHelpCleared(reason));
    this.audit(row, CLEARED_ACTION[reason], actor, {
      raised_at: raisedAt, ...(row.call_id ? { call_id: row.call_id } : {}),
    });
    this.frame(row.session_id, { event: 'help_cleared', raised_at: raisedAt, reason });
    log.info({ sessionId: row.session_id, reason }, 'Need help cleared');
  }

  private frame(sessionId: string, frame: StationFrame): void {
    this.safely(() => { this.deps.send(sessionId, frame); });
  }

  private audit(
    subject: { tenant_id: string; account_id: string; campaign_id: string | null } & ({ id: string } | { session_id: string }),
    action: HelpAuditAction | 'agency_session.message_sent',
    actor: AuditActorFields,
    details: Record<string, unknown>,
  ): void {
    const sessionId = 'session_id' in subject ? subject.session_id : subject.id;
    this.safely(() => this.deps.audit({
      tenant_id: subject.tenant_id,
      account_id: subject.account_id,
      ...actor,
      action,
      resource_type: 'agency_session',
      resource_id: sessionId,
      ...(subject.campaign_id ? { campaign_id: subject.campaign_id } : {}),
      details: { ...details, ...(subject.campaign_id ? { campaign_id: subject.campaign_id } : {}) },
    }));
  }

  /** A side effect that must never fail the transition it reports. */
  private safely(fn: () => void): void {
    try { fn(); } catch (err) { log.warn({ err }, 'Floor assist side effect failed'); }
  }
}

// ── The routes' rules (pure) ─────────────────────────────────────────────────

/**
 * The characters a message may not hold (LF17): the C0 controls but tab and line feed (`U+0000`,
 * which Postgres cannot store in `text`, among them), DEL, and a lone UTF-16 surrogate (which is no
 * character at all, and would be stored as U+FFFD). A carriage return is not among them: it is
 * turned into a line feed first.
 */
const MESSAGE_FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F]|\p{Cs}/u;

/**
 * A message's text as stored, or null when it is not one (`400 message_invalid`): line breaks made
 * `\n` (`\r\n` and a lone `\r`), trimmed, then 1 to `AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS` code points
 * holding none of {@link MESSAGE_FORBIDDEN} (refused, never stripped: what the agent reads is what
 * the supervisor wrote). The public layer and the internal handler both apply it.
 */
export function normaliseMessageText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (MESSAGE_FORBIDDEN.test(text)) return null;
  const chars = [...text].length;
  return chars >= 1 && chars <= AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS ? text : null;
}

/** The longest sender name a message's frame carries, in code points; a longer one is cut ({@link senderNameForFrame}). */
export const SENDER_NAME_MAX_CHARS = 120;

/**
 * The sender's display name as a message's frame carries it (`from_name`): trimmed, cut to
 * {@link SENDER_NAME_MAX_CHARS} code points (never inside a surrogate pair) with an ellipsis; null
 * for none or an empty one. The name is read on the server, so a long one is shortened, never a
 * reason to refuse the message.
 */
export function senderNameForFrame(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const chars = [...trimmed];
  return chars.length <= SENDER_NAME_MAX_CHARS ? trimmed : `${chars.slice(0, SENDER_NAME_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/** The refusals' sentences (British English; the console and the app key their own copy off `code`). */
export const FLOOR_ASSIST_REFUSAL_MESSAGES = {
  floor_assist_disabled: 'Need help and messages to agents are not turned on for this account.',
  help_not_on_call: 'You can ask for help during a call, or while you finish one.',
  agent_not_live: 'This agent is not connected to their station, so the message could not be shown. Try again when they are back.',
  message_invalid: `Write a message of 1 to ${AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS} characters.`,
} as const satisfies Readonly<Record<AgencyFloorAssistErrorCode, string>>;
