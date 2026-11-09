import { z } from 'zod';
import {
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_MISSED_REASONS,
} from '@magick-agency/contracts/api/agency/inbound';

/**
 * `GET /inbound/missed`'s query (`AgencyInboundMissedListQuery`), validated at the public edge
 * and again by the internal handler, from this one schema (the soft phone list's arrangement).
 * Every id is a UUID before it reaches a `::uuid` cast (22P02 otherwise); `assignee` is `me`,
 * `unassigned` or a user id; `from` / `to` bound `arrived_at`, `to` exclusive. Unknown keys are
 * stripped.
 */
export const INBOUND_MISSED_DEFAULT_LIMIT = 50;
export const INBOUND_MISSED_MAX_LIMIT = 100;

export const inboundMissedQuerySchema = z.object({
  status: z.enum(AGENCY_INBOUND_FOLLOW_UP_STATUSES).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  reason: z.enum(AGENCY_INBOUND_MISSED_REASONS).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(INBOUND_MISSED_MAX_LIMIT).optional(),
});

export type InboundMissedQuery = z.infer<typeof inboundMissedQuerySchema>;

/** The validated query as `callCore`'s string map (only the keys that are set). */
export function inboundMissedQueryString(query: InboundMissedQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}
