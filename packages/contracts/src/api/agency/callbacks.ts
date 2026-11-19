/**
 * **NEW.** The account's callbacks in one list (the Live floor's Callbacks page, decisions LF1,
 * LF22): `GET /proxy/agency/callbacks?due=overdue|today&campaign_id=&cursor=&limit=`.
 *
 * - **Gate:** `agency.supervise`, then the account scope (`400 account_scope_required`), then the
 *   dialer flag (`403 feature_disabled`), in that order, as the floor. Not the assignment flag (a
 *   `pool` campaign books callbacks too) and not the Live floor's assist flag.
 * - **Rows:** one per open callback (a `pending` contact waiting on a booked callback: its last
 *   outcome booked one, or the customer rang in and reached nobody, docs/inbound.md §7) on the
 *   account's ACTIVE campaigns (`running`, `stopping`, `paused`), as the campaign Insights tab and
 *   Home count them:
 *   - `due=overdue` (the default): due before now, the allocation's `callbacks_overdue` and the
 *     Live floor's late-callbacks count;
 *   - `due=today`: due from now until midnight in the campaign's own time zone, the allocation's
 *     `callbacks_due_today`.
 * - **`campaign_id`:** only that campaign's rows. A campaign that is not an active campaign of the
 *   caller's account answers no rows (never a 404: the list is no oracle of other accounts).
 * - **Order and paging:** by due time, then contact id, oldest first: a keyset page
 *   (`AgencyKeysetPage`), `next_cursor` opaque. `limit` 1 to {@link AGENCY_CALLBACKS_PAGE_MAX},
 *   default {@link AGENCY_CALLBACKS_PAGE_DEFAULT}.
 * - **Never the number.** A row names the customer (the roster's name column), never the phone
 *   number; neither does the cursor. Never cached (`Cache-Control: no-store`).
 * - A malformed `due`, `campaign_id`, `cursor` or `limit` is `400` with code
 *   {@link AGENCY_CALLBACKS_QUERY_ERROR_CODE}.
 */

import type { AgencyAssignmentMode, AgencyKeysetPage } from '../../agency';
import type { AllListed } from '../../primitives';

/** The 400 `code` of a callbacks list whose query the server refuses (body `{ error, code, message }`). */
export const AGENCY_CALLBACKS_QUERY_ERROR_CODE = 'invalid_callbacks_query';

/** The page size when the query names none. */
export const AGENCY_CALLBACKS_PAGE_DEFAULT = 50;

/** The largest page the list serves. */
export const AGENCY_CALLBACKS_PAGE_MAX = 200;

/** Which callbacks: overdue (due before now), or due later today (now until the campaign's local midnight). */
export type AgencyCallbacksDue = 'overdue' | 'today';
export const AGENCY_CALLBACKS_DUE_VALUES = ['overdue', 'today'] as const;

/** `GET /callbacks`. */
export interface AgencyCallbacksQuery {
  /** Default `overdue`. */
  due?: AgencyCallbacksDue;
  campaign_id?: string;
  cursor?: string;
  limit?: number;
}

/** A callback's owner, as the list names them. */
export interface AgencyCallbackOwner {
  user_id: string;
  /** Joined from `users`; null when the account has none to show. */
  name: string | null;
  /**
   * Whether they have a session present on the callback's campaign now (joined and not `offline`;
   * on a break counts): the rule the CA5 fallback and the hand-off (LF7) read. An overdue
   * callback whose owner is not live is one "Give to free agents" would move.
   */
  live: boolean;
}

/** One open callback. `campaign_id` with `contact_id` is the link to the contact (the campaign's roster). */
export interface AgencyAccountCallback {
  contact_id: string;
  campaign_id: string;
  campaign_name: string;
  /** The campaign's assignment mode: who would dial it (LF7's action is offered on `strict` and `preferred` only). */
  assignment_mode: AgencyAssignmentMode;
  /** The roster contact's name, or null. Never the number. */
  customer_name: string | null;
  /** ISO-8601. When the callback is due (the contact's next attempt). */
  due_at: string;
  /** Null: in the pool, nobody's. */
  owner: AgencyCallbackOwner | null;
  /** `inbound`: booked because the customer rang in and reached nobody; `outcome`: an agent's outcome booked it. */
  source: AgencyCallbackSource;
}

/** Where a callback came from. */
export type AgencyCallbackSource = 'outcome' | 'inbound';
export const AGENCY_CALLBACK_SOURCES = ['outcome', 'inbound'] as const;

/** `GET /callbacks`. */
export interface AgencyCallbacksPage extends AgencyKeysetPage<AgencyAccountCallback> {
  due: AgencyCallbacksDue;
  /** ISO-8601. Server time of the read: "overdue" and "today" are cut at it. */
  as_of: string;
}

// Each runtime list names its union exactly (two-sided).
const _dueListed: AllListed<AgencyCallbacksDue, typeof AGENCY_CALLBACKS_DUE_VALUES> = true;
const _sourcesListed: AllListed<AgencyCallbackSource, typeof AGENCY_CALLBACK_SOURCES> = true;
void [_dueListed, _sourcesListed];
