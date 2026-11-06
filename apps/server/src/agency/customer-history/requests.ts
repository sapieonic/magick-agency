/**
 * The customer-history request bodies (`packages/contracts/src/api/agency/customer-history.ts`),
 * validated. A LEAF apart from zod and the contract's constants: no I/O.
 *
 * A malformed body is `400 invalid_search_request`. The number itself is read by
 * `parseSearchNumber` (`packages/domain`) after this, and the search id and the cursor after
 * that, each with its own refusal (`docs/customer-history.md` §2).
 */
import { z } from 'zod';
import {
  CUSTOMER_SEARCH_BYS,
  CUSTOMER_SEARCH_VALUE_MAX,
  CUSTOMER_TIMELINE_CHANNELS,
  CUSTOMER_TIMELINE_PAGE_MAX,
  CUSTOMER_TIMELINE_PAGE_SIZE,
  type CustomerTimelineFilters,
} from '@magick-agency/contracts/api/agency/customer-history';
import { AGENCY_MANUAL_CALL_OUTCOMES } from '@magick-agency/contracts/agency';
import { UUID_RE } from '../../utils/uuid.js';
import { toMicroInstant } from './cursor.js';

/** The most values one list filter takes. */
export const CUSTOMER_FILTER_LIST_MAX = 100;

const uuid = z.string().regex(UUID_RE, 'must be a UUID').transform((s) => s.toLowerCase());
const instant = z.string().datetime({ offset: true });

export const customerSearchRequestSchema = z.object({
  by: z.enum(CUSTOMER_SEARCH_BYS),
  value: z.string().max(CUSTOMER_SEARCH_VALUE_MAX, `value is at most ${CUSTOMER_SEARCH_VALUE_MAX} characters`),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'country is an ISO 3166-1 alpha-2 code').optional(),
});

export const customerTimelineFiltersSchema = z.object({
  campaign_ids: z.array(uuid).max(CUSTOMER_FILTER_LIST_MAX).optional(),
  from: instant.optional(),
  to: instant.optional(),
  outcomes: z.array(z.enum(AGENCY_MANUAL_CALL_OUTCOMES)).max(CUSTOMER_FILTER_LIST_MAX).optional(),
  disposition_codes: z.array(z.string().min(1).max(50)).max(CUSTOMER_FILTER_LIST_MAX).optional(),
  agent_user_ids: z.array(uuid).max(CUSTOMER_FILTER_LIST_MAX).optional(),
  connected_only: z.boolean().optional(),
  channel: z.enum(CUSTOMER_TIMELINE_CHANNELS).optional(),
}).refine((f) => !(f.from && f.to) || new Date(f.from).getTime() < new Date(f.to).getTime(), {
  message: 'from must be before to',
});

/** A search id as minted: `chs_` + 32 hex. Anything else is unknown (`404 search_expired`), not malformed. */
const searchId = z.string().max(64);

export const customerTimelineRequestSchema = z.object({
  search_id: searchId,
  filters: customerTimelineFiltersSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(CUSTOMER_TIMELINE_PAGE_MAX).optional(),
});

export const customerExportRequestSchema = z.object({
  search_id: searchId,
  filters: customerTimelineFiltersSchema.optional(),
});

export type ParsedSearchRequest = z.infer<typeof customerSearchRequestSchema>;
export type ParsedTimelineRequest = z.infer<typeof customerTimelineRequestSchema>;
export type ParsedExportRequest = z.infer<typeof customerExportRequestSchema>;

/** The filters as the timeline applies them: sets, and `from` / `to` in the microsecond form `at` is compared in. */
export interface TimelineFilter {
  campaignRoots: ReadonlySet<string> | null;
  fromAt: string | null;
  toAt: string | null;
  outcomes: ReadonlySet<string> | null;
  dispositionCodes: ReadonlySet<string> | null;
  agentUserIds: ReadonlySet<string> | null;
  connectedOnly: boolean;
  channel: 'campaign' | 'softphone' | null;
  /** Any call-only filter set: only call entries are kept. */
  callsOnly: boolean;
}

const setOf = (values: readonly string[] | undefined): ReadonlySet<string> | null =>
  values && values.length > 0 ? new Set(values) : null;

export function toTimelineFilter(filters: CustomerTimelineFilters | undefined): TimelineFilter {
  const f = filters ?? {};
  const outcomes = setOf(f.outcomes);
  const dispositionCodes = setOf(f.disposition_codes);
  const agentUserIds = setOf(f.agent_user_ids);
  const connectedOnly = f.connected_only === true;
  const channel = f.channel ?? null;
  return {
    campaignRoots: setOf(f.campaign_ids),
    fromAt: f.from ? toMicroInstant(f.from) : null,
    toAt: f.to ? toMicroInstant(f.to) : null,
    outcomes,
    dispositionCodes,
    agentUserIds,
    connectedOnly,
    channel,
    callsOnly: outcomes !== null || dispositionCodes !== null || agentUserIds !== null || connectedOnly || channel !== null,
  };
}

/** The page size asked for, else the default. */
export function pageLimit(limit: number | undefined): number {
  return limit ?? CUSTOMER_TIMELINE_PAGE_SIZE;
}

/** Bounded filters for the audit row: list values are clipped, as the spine export's are. */
export function auditFilters(filters: CustomerTimelineFilters | undefined): Record<string, unknown> {
  if (!filters) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 60)) : v;
  }
  return out;
}
