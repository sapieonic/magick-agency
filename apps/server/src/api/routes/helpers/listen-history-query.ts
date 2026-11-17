import { z } from 'zod';
import { AGENCY_LISTEN_HISTORY_MAX_LIMIT } from '@magick-agency/contracts/api/agency/listen-history';

/*
 * The listening history's query (`AgencyListenHistoryQuery`, docs/listening.md §12), validated
 * at the public edge and again by the internal handler, from these schemas (a parsed query goes to
 * the internal handler as `definedQueryString(query)`). Ids are UUIDs, lower-cased, before
 * they reach a `::uuid` cast (22P02 otherwise); `from` / `to` are ISO instants with an offset,
 * `to` exclusive and not before `from` (an inverted range is the caller's mistake, never an empty
 * history). Unknown keys are refused: a misspelt filter must not read as "no filter".
 */

/** A UUID in either case, lower-cased: the form Postgres returns, so every id compared below matches. */
const userId = z.string().uuid().transform((id) => id.toLowerCase()).optional();

const filters = {
  listener_user_id: userId,
  agent_user_id: userId,
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
