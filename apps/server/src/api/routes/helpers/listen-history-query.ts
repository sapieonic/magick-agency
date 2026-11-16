import { z } from 'zod';
import {
  AGENCY_LISTEN_HISTORY_MAX_LIMIT,
  type AgencyListenHistoryQuery,
} from '@magick-agency/contracts/api/agency/listen-history';

/*
 * The listening history's query (`AgencyListenHistoryQuery`, docs/listening.md §12), validated
 * at the public edge and again by the internal handler, from these schemas. Ids are UUIDs before
 * they reach a `::uuid` cast (22P02 otherwise); `from` / `to` are ISO instants with an offset,
 * `to` exclusive and not before `from` (an inverted range is the caller's mistake, never an empty
 * history). Unknown keys are refused: a misspelt filter must not read as "no filter".
 */

const filters = {
  listener_user_id: z.string().uuid().optional(),
  agent_user_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
};

const ordered = (q: { from?: string; to?: string }): boolean => !(q.from && q.to) || new Date(q.from) <= new Date(q.to);
const ORDERED_ISSUE = { message: '`from` must not be later than `to`', path: ['to'] };

/** `GET /listen-history`. */
export const listenHistoryQuerySchema = z.object({
  ...filters,
  limit: z.coerce.number().int().min(1).max(AGENCY_LISTEN_HISTORY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict().refine(ordered, ORDERED_ISSUE);

/** `GET /listen-history.csv`: the filters only (the export walks every page itself). */
export const listenHistoryExportQuerySchema = z.object(filters).strict().refine(ordered, ORDERED_ISSUE);

export type ListenHistoryFilters = Pick<AgencyListenHistoryQuery, 'listener_user_id' | 'agent_user_id' | 'from' | 'to'>;

/** The filters as the internal handler's query string (lower-cased ids; absent keys omitted). */
export function listenHistoryFilterQuery(f: ListenHistoryFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.listener_user_id) out['listener_user_id'] = f.listener_user_id.toLowerCase();
  if (f.agent_user_id) out['agent_user_id'] = f.agent_user_id.toLowerCase();
  if (f.from) out['from'] = f.from;
  if (f.to) out['to'] = f.to;
  return out;
}
