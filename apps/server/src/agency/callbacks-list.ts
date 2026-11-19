/**
 * The account's callbacks list (decisions LF1, LF22; contracts `api/agency/callbacks.ts`): its query
 * and its rows, pure. The read is `db/repositories/agency/callbacks.repository.ts`; the route
 * `api/routes/proxy-agency-callbacks.routes.ts`.
 */
import {
  AGENCY_CALLBACKS_DUE_VALUES,
  AGENCY_CALLBACKS_PAGE_DEFAULT,
  AGENCY_CALLBACKS_PAGE_MAX,
  type AgencyAccountCallback,
  type AgencyCallbacksDue,
} from '@magick-agency/contracts/api/agency/callbacks';
import { decodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { CallbacksPageRow } from '../db/repositories/agency.repository.js';
import { isUuid } from '../utils/uuid.js';
import { matchName } from './inbound/match-name.js';

/** `GET /callbacks`, validated. */
export interface CallbacksListQuery {
  due: AgencyCallbacksDue;
  /** Lower-cased. */
  campaignId: string | null;
  after: AgencyKeysetPosition | null;
  limit: number;
}

/** A query value read once: a repeated parameter is refused, not picked from. */
function single(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw : null;
}

/**
 * The list's query: `due` (`overdue`, the default, or `today`), `campaign_id` (a UUID), `cursor` (a
 * `next_cursor` this list minted) and `limit` (1 to {@link AGENCY_CALLBACKS_PAGE_MAX}, default
 * {@link AGENCY_CALLBACKS_PAGE_DEFAULT}). A repeated parameter, or one malformed, is refused with
 * the reason; an empty one is absent. A bad cursor is refused, never read as the first page (a list
 * that quietly restarted would show the same rows twice).
 */
export function parseCallbacksQuery(query: Record<string, unknown> | undefined): { ok: true; query: CallbacksListQuery } | { ok: false; message: string } {
  const q = query ?? {};
  const due = single(q['due']);
  const campaign = single(q['campaign_id']);
  const cursor = single(q['cursor']);
  const limit = single(q['limit']);
  if (due === null || campaign === null || cursor === null || limit === null) {
    return { ok: false, message: 'Each of due, campaign_id, cursor and limit may be given once.' };
  }
  if (due && !(AGENCY_CALLBACKS_DUE_VALUES as readonly string[]).includes(due)) {
    return { ok: false, message: '`due` must be overdue or today.' };
  }
  if (campaign && !isUuid(campaign)) return { ok: false, message: '`campaign_id` must be a campaign id.' };
  let after: AgencyKeysetPosition | null = null;
  if (cursor) {
    after = decodeKeysetCursor(cursor);
    if (!after) return { ok: false, message: '`cursor` is not one this list gave. Start again from the first page.' };
  }
  let size = AGENCY_CALLBACKS_PAGE_DEFAULT;
  if (limit) {
    const n = /^\d{1,4}$/.test(limit) ? Number(limit) : NaN;
    if (!(n >= 1 && n <= AGENCY_CALLBACKS_PAGE_MAX)) {
      return { ok: false, message: `\`limit\` must be a whole number from 1 to ${AGENCY_CALLBACKS_PAGE_MAX}.` };
    }
    size = n;
  }
  return {
    ok: true,
    query: { due: (due || 'overdue') as AgencyCallbacksDue, campaignId: campaign ? campaign.toLowerCase() : null, after, limit: size },
  };
}

/** What a row of the read carries, as `callbacksRow` needs it: all but the cursor's key. */
export type CallbacksListSourceRow = Omit<CallbacksPageRow, 'due_key'>;

/**
 * One wire row: the campaign's name and mode from the active campaigns read, the customer's name
 * from the roster's columns as the floor names a customer (`matchName`), never the number, the
 * owner's name from `names`.
 */
export function callbacksRow(
  row: CallbacksListSourceRow,
  campaign: { name: string; assignment_mode: AgencyAccountCallback['assignment_mode'] },
  names: ReadonlyMap<string, string | null>,
): AgencyAccountCallback {
  return {
    contact_id: row.contact_id,
    campaign_id: row.campaign_id,
    campaign_name: campaign.name,
    assignment_mode: campaign.assignment_mode,
    customer_name: matchName(row.context) ?? null,
    due_at: new Date(row.due_at).toISOString(),
    owner: row.owner_id ? { user_id: row.owner_id, name: names.get(row.owner_id) ?? null, live: row.owner_live } : null,
    source: row.inbound ? 'inbound' : 'outcome',
  };
}
