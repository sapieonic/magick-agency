/**
 * **NEW.** The account's listening history (docs/listening.md §12, decision LS19): who listened to
 * which call, when, for how long and how it ended, for every call type (dialler, soft phone,
 * inbound), read from `agency_listen_sessions`.
 *
 * Routes (under `/proxy/agency`, Firebase session, tenant and account headers; `agency.supervise`;
 * `403 feature_disabled` while `agency_live_listen_enabled` is off for the account, and
 * `503 listen_unavailable` when the flag cannot be read):
 *  - `GET /listen-history`      {@link AgencyListenHistoryQuery} → {@link AgencyListenHistoryResponse},
 *    newest first, keyset-paged (`next_cursor`, opaque)
 *  - `GET /listen-history.csv`  the same filters (no `limit`, no `cursor`) → `text/csv`, every
 *    entry the filters keep up to {@link AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS} (`X-Export-Rows`;
 *    past the cap or the time budget `X-Export-Truncated: true` and `X-Export-Truncated-Reason`),
 *    audited (`agency_listen_sessions.exported`). Numbers masked, as on the page.
 *
 * **One entry is one visit, merged on the server.** A supervisor's reconnects make several
 * session rows for one listen (each attach is its own audited session, docs/listening.md §3). The
 * server merges a supervisor's sessions on one call into one entry while each starts no later than
 * {@link AGENCY_LISTEN_HISTORY_MERGE_GAP_MS} after every earlier one of the entry ended (or while
 * an earlier one is still open). The page and the CSV show the same entries; `listen_ids` names
 * the sessions merged. The date range filters the sessions by their start before merging.
 *
 * Numbers are masked (`****1234`); a caller who withheld their number is
 * `customer_phone_withheld: true` with `customer_phone_masked: null`; a call whose row has been
 * purged has neither. Names are resolved by the public layer (null when the user is gone).
 */

import type { AgencyCallOrigin, AgencyListenEndReason } from '../../agency/listen';

/**
 * Two sessions of one supervisor on one call are one entry when the later starts at most this
 * long after the earlier ones ended: twice the console's reconnect window
 * (`AGENCY_LISTEN_RECONNECT_WINDOW_MS`, 15 s), so a reconnect and a quick "Listen" again are one
 * visit, and a supervisor who comes back minutes later is a new one.
 */
export const AGENCY_LISTEN_HISTORY_MERGE_GAP_MS = 30_000;

/** The page size when `limit` is absent, and its ceiling. */
export const AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT = 50;
export const AGENCY_LISTEN_HISTORY_MAX_LIMIT = 100;

/** The CSV's row ceiling (entries, not sessions). */
export const AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS = 10_000;

/**
 * How a listen ended, in words (British English): the history page and the CSV's
 * `how_it_ended` column. One entry per end reason: a new reason in
 * `AGENCY_LISTEN_END_REASONS` fails to compile here until it has its words.
 */
export const AGENCY_LISTEN_END_REASON_LABELS: Readonly<Record<AgencyListenEndReason, string>> = {
  call_ended: 'The call ended',
  listener_stopped: 'Stopped by the supervisor',
  listener_disconnected: 'Connection lost',
  permission_revoked: 'Access to listen was removed',
  access_unverified: 'Access could not be checked',
  superseded: 'Started listening elsewhere',
  send_backlog: 'Connection too slow',
  tap_error: 'The call audio could not be relayed',
  server_shutdown: 'The service restarted',
  server_restarted: 'The service restarted',
};

/** `GET /listen-history` query. Every field optional; unknown keys are refused (400). */
export interface AgencyListenHistoryQuery {
  /** One supervisor's listens. */
  listener_user_id?: string;
  /** Listens to one agent's calls. */
  agent_user_id?: string;
  /** Sessions started at or after this instant (ISO 8601 with offset). */
  from?: string;
  /** Sessions started before this instant (exclusive). Not before `from`. */
  to?: string;
  /** 1–{@link AGENCY_LISTEN_HISTORY_MAX_LIMIT}, default {@link AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT}. */
  limit?: number;
  /** The previous page's `next_cursor`. A cursor this API did not issue is a 400. */
  cursor?: string;
}

/** One visit: a supervisor's merged sessions on one call. */
export interface AgencyListenHistoryEntry {
  /** The first session's listen id: the entry's stable id. */
  id: string;
  /** Every session merged into the entry, earliest first. */
  listen_ids: string[];
  call_id: string;
  /** Dialler (`campaign`), soft phone (`manual`) or inbound. */
  origin: AgencyCallOrigin;
  /**
   * The call's spine row, for the link to the call: the attempt (`campaign`: the campaign's
   * attempt page), the manual call (the soft-phone call page) or the inbound call.
   */
  correlation_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  inbound_route_name: string | null;
  listener_user_id: string;
  listener_name: string | null;
  agent_user_id: string;
  agent_name: string | null;
  /** The roster contact's name, or null without one. */
  customer_name: string | null;
  /** `****1234`; null when withheld or when the call's row is gone. */
  customer_phone_masked: string | null;
  customer_phone_withheld: boolean;
  /** ISO 8601: the first session's start. */
  started_at: string;
  /** ISO 8601: the last session's end; null while one is still open. */
  ended_at: string | null;
  /** Time listened, overlaps counted once and the gaps between sessions not at all; null while open. */
  listened_seconds: number | null;
  /** How the session that ended last ended; null while open. Words: {@link AGENCY_LISTEN_END_REASON_LABELS}. */
  end_reason: AgencyListenEndReason | null;
}

export interface AgencyListenHistoryResponse {
  entries: AgencyListenHistoryEntry[];
  /** Null on the last page. Opaque. */
  next_cursor: string | null;
}
