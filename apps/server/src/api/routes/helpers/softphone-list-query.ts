import { z } from 'zod';
import { AGENCY_MANUAL_CALL_OUTCOMES } from '@magick-agency/contracts/agency';
import type { AgencyManualCallListFilters } from '../../../db/repositories/agency.repository.js';

/**
 * `GET /softphone/calls`'s query (`AgencyManualCallListQuery`), validated at the public
 * edge and again by the internal handler, from this one schema. Every id is a UUID before
 * it reaches a `::uuid` cast (22P02 otherwise); `campaign_id` is a campaign or `untagged`;
 * `phone` is digits (a suffix match); `contact_id` a roster contact; `from` / `to` bound
 * `created_at`, `to` exclusive.
 * Unknown keys are stripped.
 */
export const SOFTPHONE_LIST_DEFAULT_LIMIT = 50;
export const SOFTPHONE_LIST_MAX_LIMIT = 100;

export const softphoneListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SOFTPHONE_LIST_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(512).optional(),
  agent_user_id: z.string().uuid().optional(),
  campaign_id: z.union([z.literal('untagged'), z.string().uuid()]).optional(),
  status: z.enum(['live', 'awaiting_outcome', 'settled']).optional(),
  outcome: z.enum(AGENCY_MANUAL_CALL_OUTCOMES).optional(),
  disposition_code: z.string().min(1).max(50).optional(),
  phone: z.string().regex(/^\d{1,20}$/, 'digits only').optional(),
  /** A roster contact's soft-phone calls (the contact detail). Another agent's calls need supervise, as always. */
  contact_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export type SoftphoneListQuery = z.infer<typeof softphoneListQuerySchema>;

/** The parsed query as the repository's filters (the agent is the caller's to decide). */
export function softphoneListFilters(query: SoftphoneListQuery): Omit<AgencyManualCallListFilters, 'agentUserId'> {
  return {
    ...(query.campaign_id === 'untagged'
      ? { campaign: 'untagged' as const }
      : query.campaign_id ? { campaign: { campaignId: query.campaign_id } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.disposition_code ? { dispositionCode: query.disposition_code } : {}),
    ...(query.phone ? { phoneDigits: query.phone } : {}),
    ...(query.contact_id ? { contactId: query.contact_id } : {}),
    ...(query.from ? { from: new Date(query.from) } : {}),
    ...(query.to ? { to: new Date(query.to) } : {}),
  };
}

/** The validated query as `callCore`'s string map (only the keys that are set). */
export function softphoneListQueryString(query: SoftphoneListQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}
