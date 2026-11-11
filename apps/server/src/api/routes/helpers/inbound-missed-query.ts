import { z } from 'zod';
import {
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_MISSED_ASSIGNEE_ME,
  AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED,
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

const assignee = z.union([
  z.literal(AGENCY_INBOUND_MISSED_ASSIGNEE_ME),
  z.literal(AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED),
  z.string().uuid(),
]);

export const inboundMissedQuerySchema = z.object({
  status: z.enum(AGENCY_INBOUND_FOLLOW_UP_STATUSES).optional(),
  assignee: assignee.optional(),
  reason: z.enum(AGENCY_INBOUND_MISSED_REASONS).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(INBOUND_MISSED_MAX_LIMIT).optional(),
});

export type InboundMissedQuery = z.infer<typeof inboundMissedQuerySchema>;

/**
 * `GET /inbound/missed/count`'s query (`AgencyInboundMissedCountQuery`): the list's `assignee`
 * (IQ57) and `since`, rows that arrived at or after it (IQ50). Validated at the public edge and
 * again by the internal handler. Unknown keys are stripped.
 */
export const inboundMissedCountQuerySchema = z.object({
  assignee: assignee.optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export type InboundMissedCountQuery = z.infer<typeof inboundMissedCountQuerySchema>;

/**
 * Whose rows a Missed read covers, from the caller and the `assignee` asked for (the list's rule,
 * which the count shares, IQ57):
 *  - `unassigned`: the account's rows assigned to nobody, for ANY caller with the list (IQ49's
 *    Team view: an agent reads them to claim one);
 *  - without `agency.supervise`, anything else: the caller's own rows, whatever was asked (§8.1);
 *  - `me`: the caller's own rows (a supervisor's badge counts what their list shows);
 *  - a user id: that person's rows (supervise only);
 *  - absent: everyone's (supervise only).
 */
export function missedAssigneeScope(
  actor: { userId: string; supervise: boolean },
  asked: string | undefined,
): { userId: string } | 'unassigned' | undefined {
  if (asked === AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED) return 'unassigned';
  if (!actor.supervise || asked === AGENCY_INBOUND_MISSED_ASSIGNEE_ME) return { userId: actor.userId };
  return asked ? { userId: asked.toLowerCase() } : undefined;
}
