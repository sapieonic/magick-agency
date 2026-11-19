/**
 * Floor assist (the Live floor's Phase 3, decisions LF4, LF5, LF11 onwards): an agent's **Need
 * help** on their own live session, and a supervisor's **message** to an agent's station (Talk to
 * agent, Send reminder). Both are gated by the `agency_floor_assist_enabled` flag (`../flags.ts`,
 * off by default); refusals are `AgencyFloorAssistErrorCode` (`../errors.ts`). Types and `as const`
 * lists only, like the rest of this barrel.
 *
 * ── Need help (LF4) ─────────────────────────────────────────────────────────
 * `POST /proxy/agency/sessions/:id/help` raises it on the caller's own live session while they are
 * on a call or in wrap-up (a soft-phone call, live or owing its outcome, counts);
 * `DELETE /proxy/agency/sessions/:id/help` cancels it. Both answer {@link AgencyHelpResponse}.
 * Raising again while one is open changes nothing and answers the open one. Every
 * `agency.supervise` holder in the account sees it on the floor read (`GET /proxy/agency/floor`,
 * `AgencyFloorAgent.help`), which the console polls every 5 s: there is no supervisor push.
 *
 * It clears, exactly once, on the first of:
 *  - an answer: a supervisor's listen on the agent's call going live (`how: 'listen'`), or a
 *    supervisor's message reaching the agent's station (`how: 'message'`);
 *  - the agent's cancel;
 *  - {@link AGENCY_HELP_EXPIRY_MS} after it was raised (read as cleared at once by every read; the
 *    server's sweep sends the frame and writes the audit row within its interval);
 *  - the session ending (the agent leaves).
 * The station is sent {@link AgencyStationHelpClearedFrame} for every one of them, after an
 * {@link AgencyStationHelpAnsweredFrame} for an answer.
 *
 * ── Messages (LF5) ──────────────────────────────────────────────────────────
 * `POST /proxy/agency/sessions/:id/messages` (`agency.supervise`), body
 * {@link AgencySupervisorMessageRequest}, sends {@link AgencyStationSupervisorMessageFrame} to the
 * session's live station (console or app) and answers {@link AgencySupervisorMessageResponse} (201).
 * Send reminder is the same route with words the console fills in. With no live station that can
 * receive it, `409 agent_not_live`. Every message is kept {@link AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS}
 * days (`agency_supervisor_messages`, `0052_floor_assist.sql`).
 *
 * ── The station frames, and which stations get them ─────────────────────────
 * {@link AgencyStationFloorAssistFrame}: `supervisor_message`, `help_answered`, `help_cleared`. A
 * console station always gets them. A mobile station gets them only when its upgrade declares the
 * capability {@link AGENCY_STATION_FLOOR_ASSIST_CAPABILITY} (`caps=…`), so an app build that cannot
 * show a message is never sent one and a message to it is `409 agent_not_live`, never a message
 * nobody sees (as the inbound frames, `AGENCY_STATION_INBOUND_EVENTS`).
 *
 * The three frames are members of `AgencyStationServerFrame` (`./station.ts`), and
 * {@link AgencyStationFloorAssistFrame} names them as a subset for the server's one check of which
 * stations get them. They were staged outside it until the app's wire package could decode them
 * (LF16); the app's Phase 3 change moved them in with its Dart types, its fixtures
 * (`fixtures/agent/station.json`, `fixtures/agent/floor-assist.json`) and the literals, and its
 * station declares `caps=floor_assist` on every upgrade.
 */

import type { AllListed } from '../primitives';
import type { AgencyStationCapability } from './station';

// ─── Need help ───────────────────────────────────────────────────────────────

/** How long a Need help request stays open unanswered: 15 minutes from when it was raised (LF4). */
export const AGENCY_HELP_EXPIRY_MS = 15 * 60_000;

/** An open Need help request on a session. */
export interface AgencySessionHelp {
  /** ISO-8601. When the agent raised it. Identifies the request: the frames that end it carry it too. */
  raised_at: string;
  /**
   * The call the agent was on when they raised it (`agency_calls.id`, what
   * `POST /live-calls/:callId/listen` takes); null when raised in wrap-up, or before the call was
   * connected.
   */
  call_id: string | null;
}

/**
 * `POST` and `DELETE /proxy/agency/sessions/:id/help`. `help` is the open request (`POST`: the one
 * just raised, or the one already open), or null (`DELETE`: whether or not one was open).
 */
export interface AgencyHelpResponse {
  session_id: string;
  help: AgencySessionHelp | null;
}

/** How a supervisor answered a Need help request. */
export type AgencyHelpAnswerHow = 'listen' | 'message';

export const AGENCY_HELP_ANSWER_HOWS = ['listen', 'message'] as const satisfies readonly AgencyHelpAnswerHow[];

const _allHowsListed: AllListed<AgencyHelpAnswerHow, typeof AGENCY_HELP_ANSWER_HOWS> = true;
void _allHowsListed;

/** Why a Need help request ended. */
export type AgencyHelpClearedReason = 'cancelled' | 'expired' | 'answered' | 'session_ended';

export const AGENCY_HELP_CLEARED_REASONS = [
  'cancelled',
  'expired',
  'answered',
  'session_ended',
] as const satisfies readonly AgencyHelpClearedReason[];

const _allClearedReasonsListed: AllListed<AgencyHelpClearedReason, typeof AGENCY_HELP_CLEARED_REASONS> = true;
void _allClearedReasonsListed;

// ─── Messages ────────────────────────────────────────────────────────────────

/** The most characters (Unicode code points, after trimming) one message may hold. */
export const AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS = 500;

/** How long a message is kept (LF5): the retention purge deletes rows older than this. */
export const AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS = 90;

/**
 * `POST /proxy/agency/sessions/:id/messages`. `text` is trimmed by the server, and must then hold
 * 1 to {@link AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS} characters (`400 message_invalid` otherwise).
 */
export interface AgencySupervisorMessageRequest {
  text: string;
}

/** `201` from `POST /proxy/agency/sessions/:id/messages`: the message reached the agent's station. */
export interface AgencySupervisorMessageResponse {
  /** `agency_supervisor_messages.id`; the frame's `id`. */
  id: string;
  session_id: string;
  /** ISO-8601. */
  sent_at: string;
  /** Always true on a 201: a message no station took is `409 agent_not_live`. */
  delivered: true;
}

// ─── Station frames ──────────────────────────────────────────────────────────

/** The station capability a mobile station declares to be sent the floor assist frames. See the module note. */
export const AGENCY_STATION_FLOOR_ASSIST_CAPABILITY = 'floor_assist' satisfies AgencyStationCapability;

/** A supervisor's message to this agent. */
export interface AgencyStationSupervisorMessageFrame {
  event: 'supervisor_message';
  /** `agency_supervisor_messages.id`. A client shows each id once. */
  id: string;
  /** The message as stored: trimmed, 1 to {@link AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS} characters. Plain text, never markup. */
  text: string;
  /** The sender's display name; null when it could not be read (the client says "Your supervisor"). */
  from_name: string | null;
  /** ISO-8601. */
  sent_at: string;
}

/**
 * A supervisor answered this agent's Need help: they are listening to the call (`listen`) or sent
 * a message (`message`, after its `supervisor_message`). Followed at once by `help_cleared` with
 * reason `answered`, which is what ends the request on the screen; this one says who and how.
 */
export interface AgencyStationHelpAnsweredFrame {
  event: 'help_answered';
  /** The request answered: its {@link AgencySessionHelp.raised_at}. */
  raised_at: string;
  /** Who answered; null when their name could not be read. */
  by_name: string | null;
  how: AgencyHelpAnswerHow;
}

/**
 * This agent's Need help request ended. A client clears it only when `raised_at` is the request it
 * shows, so a late frame about an earlier request never clears a newer one.
 */
export interface AgencyStationHelpClearedFrame {
  event: 'help_cleared';
  /** The request that ended: its {@link AgencySessionHelp.raised_at}. */
  raised_at: string;
  reason: AgencyHelpClearedReason;
}

/** The floor assist frames: members of `AgencyStationServerFrame`, named together for the check of which stations get them. */
export type AgencyStationFloorAssistFrame =
  | AgencyStationSupervisorMessageFrame
  | AgencyStationHelpAnsweredFrame
  | AgencyStationHelpClearedFrame;

/** The floor assist frames' events: sent only to a station that can receive them. */
export const AGENCY_STATION_FLOOR_ASSIST_EVENTS = [
  'supervisor_message',
  'help_answered',
  'help_cleared',
] as const satisfies readonly AgencyStationFloorAssistFrame['event'][];

const _allFloorAssistEventsListed: AllListed<AgencyStationFloorAssistFrame['event'], typeof AGENCY_STATION_FLOOR_ASSIST_EVENTS> = true;
void _allFloorAssistEventsListed;
