/**
 * **NEW.** The agent's own day on one campaign, in one read (agent station BE-1, BE-2, BE-3; rulings
 * AS6, AS7, AS8): `GET /proxy/agency/my-day?campaign_id=<uuid>`. It feeds Ready's "My day" and
 * call-later list, Start of day's target and Finish work's summary.
 *
 * - **Gate:** `agency.station.connect`, then the account scope (`400 account_scope_required`), then
 *   the dialer flag (`403 feature_disabled`). The caller must be staffed on the campaign or hold a
 *   live session on it (`403 not_staffed`, as `my-contacts`). Not the contact-assignment flag: it
 *   serves `pool` campaigns too.
 * - **Query:** `campaign_id` only (a UUID); anything else, or a malformed one, is `400` with code
 *   {@link AGENCY_MY_DAY_QUERY_ERROR_CODE}.
 * - **The day** is the campaign's own: its local midnight to the next, in its `default_timezone`
 *   (IST for our tenants), cut by the server's clock, never the phone's.
 * - **Counted:** this agent's dialler attempts on this campaign. Soft-phone and inbound calls are
 *   not counted, as on the floor. An agent on two campaigns in a day reads each separately.
 * - **When the station reads it:** on join, on every `ready` frame, after each saved outcome, and
 *   every 60 s while Ready. No frame carries it. Old app builds never call it.
 * - **Never cached** (`Cache-Control: no-store`): it names customers. It never carries a number.
 */

import type { AllListed } from '../../primitives';

/** The 400 `code` of a my-day read whose query the server refuses (body `{ error, code, message }`). */
export const AGENCY_MY_DAY_QUERY_ERROR_CODE = 'invalid_my_day_query';

/** The most call-later rows `AgencyMyCallLater.rows` carries; the counts are not capped. */
export const AGENCY_MY_CALL_LATER_ROWS_MAX = 20;

/** `GET /my-day`. */
export interface AgencyMyDayQuery {
  campaign_id: string;
}

/** What a daily target counts. One metric today: connected calls (conversations), AS6. */
export type AgencyMyDayTargetMetric = 'calls';

export const AGENCY_MY_DAY_TARGET_METRICS = ['calls'] as const satisfies readonly AgencyMyDayTargetMetric[];

/** The campaign's daily target (`AgencyCampaign.daily_target_calls`, BE-2). */
export interface AgencyMyDayTarget {
  metric: AgencyMyDayTargetMetric;
  /** 1 to `AGENCY_DAILY_TARGET_CALLS_MAX`. */
  value: number;
}

/**
 * Where a call-later the agent leaves today goes ("Finish work"):
 *  - `pool`: another agent may make it (a `pool` campaign, or `callback_fallback = 'pool'`);
 *  - `waits_for_me`: it waits for this agent (`strict` / `preferred` with `callback_fallback = 'wait'`).
 */
export type AgencyMyCallLaterLeftGoesTo = 'pool' | 'waits_for_me';

export const AGENCY_MY_CALL_LATER_LEFT_GOES_TO = ['pool', 'waits_for_me'] as const satisfies readonly AgencyMyCallLaterLeftGoesTo[];

/** One call-later on the agent's list. */
export interface AgencyMyCallLaterRow {
  contact_id: string;
  /** The customer's name: the campaign's `name` role (BE-6), else the server's guess. Null without one. Never the number. */
  customer_name: string | null;
  /** ISO-8601. When it is due (the contact's next attempt). */
  due_at: string;
  /** Due before the read (`as_of`). */
  overdue: boolean;
}

/**
 * The agent's own call-laters (BE-3): the pending callbacks on this campaign that this agent booked
 * (`agency_contacts.callback_booked_by_user_id`, 0057), and, on `strict` / `preferred` campaigns,
 * the callbacks assigned to them (a supervisor's hand-off, LF7, and those booked before the booker
 * was recorded). Due from now to the campaign's midnight, plus the overdue ones.
 */
export interface AgencyMyCallLater {
  /** Oldest due first, at most {@link AGENCY_MY_CALL_LATER_ROWS_MAX}. */
  rows: AgencyMyCallLaterRow[];
  /** Due from now to the campaign's midnight (not overdue). */
  today: number;
  /** Due before now. */
  overdue: number;
  /**
   * True: these calls come back to this agent (a `strict` or `preferred` campaign, the contacts
   * theirs). False: a `pool` campaign, so another agent may get the call. The station's copy follows
   * it (AS8): "These calls will come to you on time." / "We will call them on time. Another agent
   * may get the call."
   */
  comes_to_me: boolean;
  /** Where a call-later the agent leaves today goes: Finish work's "Another agent will make it" only on `pool`. */
  left_today_goes_to: AgencyMyCallLaterLeftGoesTo;
}

/** `GET /my-day`. */
export interface AgencyMyDay {
  campaign_id: string;
  /** The campaign's IANA zone: the day served is its local midnight to the next. */
  timezone: string;
  /** ISO-8601. The day's start (the campaign's local midnight). */
  day_start: string;
  /** ISO-8601. The day's end (the next local midnight), exclusive. */
  day_end: string;
  /**
   * Conversations: this agent's attempts with a bridged call, a redialled conversation once, by the
   * floor's `calls_today` rule (`CONVERSATION_ATTEMPT_SQL`), so the agent and the supervisor see the
   * same number. The target bar counts these.
   */
  calls: number;
  /** Every attempt dialled for this agent today, answered or not. Context only, never the bar. */
  dialed: number;
  /** The agent's talk time today, in whole seconds (the record's `talk_seconds` rule). */
  talk_seconds: number;
  /**
   * AS7: this agent's outcomes today that recorded a promise to pay (a pay date), counted by when the
   * outcome was written; a promise corrected by a replay counts once. Null when this campaign's
   * catalog has no promise outcome: the tile is not shown.
   */
  will_pay: number | null;
  /** Connected calls today with an `is_success` outcome, for a campaign whose `will_pay` is null. */
  successes: number;
  /** BE-2. Null: the campaign has no target, so no bar (null is not zero). */
  target: AgencyMyDayTarget | null;
  /** BE-3. */
  call_later: AgencyMyCallLater;
  /** ISO-8601. Server time of the read. */
  as_of: string;
}

const _metricsListed: AllListed<AgencyMyDayTargetMetric, typeof AGENCY_MY_DAY_TARGET_METRICS> = true;
const _goesToListed: AllListed<AgencyMyCallLaterLeftGoesTo, typeof AGENCY_MY_CALL_LATER_LEFT_GOES_TO> = true;
void [_metricsListed, _goesToListed];
