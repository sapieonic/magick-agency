/**
 * **NEW.** Inbound calls in the console (`docs/inbound.md` §7, §8): an account's inbound routes
 * and its Missed inbound list. The vocabularies and the route configuration are the dialer
 * contract's (`../../agency/inbound.ts`), re-exported here so a console file needs one import.
 *
 * Routes (under `/proxy/agency`, Firebase session, tenant and account headers; every one also
 * needs the `agency_inbound_enabled` flag, else `403 inbound_disabled`):
 *  - `GET    /inbound/routes`                 `agency.inbound.write` → {@link AgencyInboundRoutesResponse}
 *  - `POST   /inbound/routes`                 `agency.inbound.write`, {@link AgencyInboundRouteCreateRequest} → 201 {@link AgencyInboundRouteResponse}
 *  - `PATCH  /inbound/routes/:id`             `agency.inbound.write`, {@link AgencyInboundRouteUpdateRequest} → {@link AgencyInboundRouteResponse}
 *  - `DELETE /inbound/routes/:id`             `agency.inbound.write` → 204 (soft delete; its numbers are detached)
 *  - `GET    /inbound/missed`                 `agency.inbound.read`, {@link AgencyInboundMissedListQuery} → {@link AgencyInboundMissedPage}
 *  - `POST   /inbound/missed/:id/handled`     `agency.inbound.read`, no body → {@link AgencyInboundMarkHandledResponse}
 *
 * `agency.inbound.read` floors at `agent`: an agent sees and handles only the rows assigned to
 * them (the route forces `assignee=me`); with `agency.supervise` the caller sees the account's.
 * Refusals are `{ error: AgencyInboundErrorCode, message, details? }` (`../../errors.ts` §6).
 */

import type { AgencyKeysetPage } from '../../agency/spine';
import type {
  AgencyInboundCallOutcome,
  AgencyInboundFollowUpStatus,
  AgencyInboundMissedReason,
  AgencyInboundRouteConfig,
} from '../../agency/inbound';

export {
  AGENCY_INBOUND_CALL_OUTCOMES,
  AGENCY_INBOUND_CALL_STATES,
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_MISSED_REASONS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS,
  AGENCY_INBOUND_STICKY_MODES,
  AGENCY_INBOUND_STICKY_REASONS,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
} from '../../agency/inbound';
export type {
  AgencyInboundCallOutcome,
  AgencyInboundCallState,
  AgencyInboundClips,
  AgencyInboundClipSlot,
  AgencyInboundFollowUpStatus,
  AgencyInboundHoliday,
  AgencyInboundHoursInterval,
  AgencyInboundMissedReason,
  AgencyInboundRouteConfig,
  AgencyInboundStickyMode,
  AgencyInboundStickyReason,
  AgencyInboundUnconnectedAction,
} from '../../agency/inbound';
export type { AgencyInboundErrorCode } from '../../errors';
export { AGENCY_INBOUND_ERROR_CODES } from '../../errors';

// ─── Routes ─────────────────────────────────────────────────────────────────

/** A number answering a route: its active attachment. */
export interface AgencyInboundRouteNumber {
  phone_number_id: string;
  /** E.164. */
  phone_number: string;
  attached_at: string;
}

/** A live route of the account, as every route read and write answers it. */
export interface AgencyInboundRoute extends AgencyInboundRouteConfig {
  id: string;
  account_id: string;
  /** Live attachments only, by number. */
  numbers: AgencyInboundRouteNumber[];
  created_at: string;
  updated_at: string;
}

export interface AgencyInboundRoutesResponse {
  /** Oldest first. An account has a handful, so the list is not paged. */
  routes: AgencyInboundRoute[];
}

export interface AgencyInboundRouteResponse {
  route: AgencyInboundRoute;
}

/**
 * `POST /inbound/routes`. `name` and `timezone` are required; every other field takes its
 * `AGENCY_INBOUND_ROUTE_DEFAULTS` value when left out (`clips` per slot). `phone_number_ids`
 * attaches numbers in the same request: each must be one of the tenant's active numbers the
 * account may use, linked to inbound by a super-admin, and on no other live route.
 */
export type AgencyInboundRouteCreateRequest =
  Pick<AgencyInboundRouteConfig, 'name' | 'timezone'>
  & Partial<Omit<AgencyInboundRouteConfig, 'name' | 'timezone' | 'clips'>>
  & {
    clips?: Partial<AgencyInboundRouteConfig['clips']>;
    phone_number_ids?: string[];
  };

/**
 * `PATCH /inbound/routes/:id`: the fields present replace the stored ones (`clips` per slot).
 * `phone_number_ids`, when present, is the route's whole set: numbers left out are detached.
 */
export type AgencyInboundRouteUpdateRequest =
  Partial<Omit<AgencyInboundRouteConfig, 'clips'>>
  & {
    clips?: Partial<AgencyInboundRouteConfig['clips']>;
    phone_number_ids?: string[];
  };

// ─── The Missed inbound list (§7) ───────────────────────────────────────────

/** One call that reached nobody. */
export interface AgencyInboundMissedCall {
  id: string;
  /** NULL: the tenant default (the number has no route). */
  account_id: string | null;
  route_id: string | null;
  route_name: string | null;
  /** E.164; NULL when the caller withheld their number. */
  from_e164: string | null;
  /** The number they rang, E.164. */
  to_e164: string;
  arrived_at: string;
  ended_at: string;
  reason: AgencyInboundMissedReason;
  outcome: AgencyInboundCallOutcome;
  /** The caller's number is on a DNC list: never dialled automatically; the agent decides. */
  caller_dnc: boolean;
  matched_contact_id: string | null;
  matched_campaign_id: string | null;
  matched_campaign_name: string | null;
  /** When the callback this call booked on the matched contact is due; NULL: none was booked. */
  callback_due_at: string | null;
  has_voicemail: boolean;
  /** NULL: the account (anyone with the list). */
  assignee_user_id: string | null;
  assignee_name: string | null;
  status: AgencyInboundFollowUpStatus;
  handled_by_user_id: string | null;
  handled_by_name: string | null;
  handled_at: string | null;
}

/**
 * `GET /inbound/missed`. Newest first, keyset paged on (`arrived_at`, `id`). `status` defaults to
 * `open`. `assignee`: `me`, `unassigned`, or a user id (supervise only). `from` / `to` bound
 * `arrived_at` (inclusive, exclusive; ISO-8601). `limit` 1–100, default 50.
 */
export interface AgencyInboundMissedListQuery {
  status?: AgencyInboundFollowUpStatus;
  assignee?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export type AgencyInboundMissedPage = AgencyKeysetPage<AgencyInboundMissedCall>;

/**
 * `POST /inbound/missed/:id/handled`, no body. Idempotent: marking a handled row again answers it
 * as it is, with its first handler and time.
 */
export interface AgencyInboundMarkHandledResponse {
  call: AgencyInboundMissedCall;
}
