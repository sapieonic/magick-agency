/**
 * One station per agent (decisions OS1–OS8, docs/decisions.md "One station per agent").
 *
 * An agent is live in one place at a time: one live session across every tenant (OS1, refused
 * `session_in_other_tenant` when it is in another tenant), and that session's station on one
 * device (OS3). A **device** is one console page load or one install of the agent app; it names
 * itself with a `device_id` it generates (the console: in memory, so a reload or a second tab is
 * another device; the app: kept with its install, so a restart is the same device).
 *
 * The session remembers the device that holds its station (`station_device_id`, 0034). A join, a
 * soft-phone open or a station-token mint that carries a `device_id`:
 *   * from the holder, or for a session no device holds: allowed, and the device holds it;
 *   * from another device without `take_over`: refused 409 `station_on_other_device`, and nothing
 *     changes. This is what a device that lost its socket (a laptop asleep, a phone out of signal)
 *     meets when it reconnects after the agent moved the station elsewhere: it never takes the
 *     station back on its own;
 *   * from another device WITH `take_over: true` (the agent pressed "Use it here" / "Use this
 *     phone", or chose to go on duty here): allowed; the device holds it, and its socket
 *     supersedes the other device's with 4409 when it attaches.
 * A request with no `device_id` (an older client): a join or soft-phone open is allowed and leaves no
 * holder (the station is then any device's to claim, as before); a token mint (a reconnect) is
 * refused while a device holds the station, so an older client never takes it back on its own.
 * `take_over` without a `device_id` means nothing.
 *
 * Not every refusal is a dead end (OS7): a live session in ANOTHER tenant with no station attached
 * and nothing in flight is ended by the join or soft-phone open, which then proceeds.
 *
 * The device id is client-declared and opaque: never an identity or a security input. The session
 * is still the authenticated agent's own (Q8); the holder only decides which of the agent's own
 * devices reconnects automatically.
 */

import type { AgencyClientKind } from './station';

/** Longest `device_id` the server keeps (`agency_agent_sessions.station_device_id` is VARCHAR(64)). */
export const AGENCY_STATION_DEVICE_ID_MAX = 64;

/**
 * What a `device_id` may be: 8–64 of letters, digits, `-` and `_` (a UUID fits). Anything else is
 * a 400 at the public layer, never stored.
 */
export const AGENCY_STATION_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The device fields of the campaign join, the soft-phone open and the station-token mint. */
export interface AgencyStationDeviceFields {
  /** This device's id (see the module note). Absent: an older client; no device holds the station. */
  device_id?: string;
  /**
   * Take the station over from whichever device holds it. Only on the agent's own explicit action
   * ("Use it here", "Use this phone", going on duty here); never on an automatic reconnect or
   * resume. Ignored without `device_id`.
   */
  take_over?: boolean;
}

/** `POST /sessions/:id/station-token` body. Empty (or absent) is an older client's mint. */
export type AgencyStationTokenRequest = AgencyStationDeviceFields;

/**
 * 409 `station_on_other_device`: another device holds this session's station, and the request did
 * not ask to take it over. Nothing changed. The client shows "Your station is open on another
 * device" with a way to take it here (the same request with `take_over: true`).
 *
 * From the campaign join and the soft-phone open (a device that resumes a session on its own) and
 * from the station-token mint (a device reconnecting). A member of `AgencyActionErrorCode` only,
 * on every one of those routes, the soft-phone open included (the two error unions never share a
 * string).
 */
export interface AgencyStationOnOtherDeviceRefusal {
  error: string;
  code: 'station_on_other_device';
  message: string;
  /** The session whose station is elsewhere: the caller's own live session. */
  session_id: string;
  /**
   * The app that last attached the session's station (`client_kind` on the session row): `mobile`
   * says "on your phone", `web` "in another browser window". Display only.
   */
  client_kind: AgencyClientKind;
}

/**
 * 409 `session_in_other_tenant`: the agent is live (a campaign or the soft phone) in ANOTHER
 * tenant they belong to (OS1). Nothing changed, and nothing here can end that session: every
 * session route is scoped to its own tenant, so the agent leaves it there (switch to that
 * workspace, or the device holding it). From the campaign join and the soft-phone open.
 */
export interface AgencySessionInOtherTenantRefusal {
  error: string;
  code: 'session_in_other_tenant';
  message: string;
  /** The tenant the live session is in. The agent's own membership, so naming it leaks nothing. */
  tenant_id: string;
  /** That tenant's name, for copy. Best effort: NULL when the read failed. */
  tenant_name: string | null;
}
