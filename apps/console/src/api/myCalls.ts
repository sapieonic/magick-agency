import { API_BASE } from '../config';
import { apiFetch } from './client';
import type { AgencyCallLogTypeFilter, AgencyMyCallsPage } from '../types/agency-call-log';

/**
 * The signed-in person's own calls (`docs/call-log.md` §7): their dials, the soft-phone calls
 * they placed, the inbound calls they answered and their open Missed rows, newest first.
 *
 *   GET /proxy/agency/my-calls → AgencyMyCallsPage
 *
 * The server decides whose calls these are (the session's user) and how each number may be
 * shown: a number its campaign hides from agents arrives already masked.
 */
export interface MyCallsOptions {
  type?: AgencyCallLogTypeFilter;
  /** A campaign's id, or `none`. */
  campaign?: string | null;
  /** Inclusive, ISO-8601, on when the call began. To follow up is not narrowed by them. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  /** Ask for `counts` (what the To follow up badge shows). */
  includeCounts?: boolean;
}

export function getMyCalls(options: MyCallsOptions = {}, tenantId?: string, accountId?: string): Promise<AgencyMyCallsPage> {
  const qs = new URLSearchParams();
  if (options.type && options.type !== 'all') qs.set('type', options.type);
  if (options.campaign) qs.set('campaign_id', options.campaign);
  if (options.from) qs.set('from', options.from);
  if (options.to) qs.set('to', options.to);
  if (options.cursor) qs.set('cursor', options.cursor);
  if (options.limit !== undefined) qs.set('limit', String(options.limit));
  if (options.includeCounts) qs.set('include_counts', '1');
  const text = qs.toString();
  return apiFetch<AgencyMyCallsPage>(`${API_BASE}/proxy/agency/my-calls${text ? `?${text}` : ''}`, {}, tenantId, accountId);
}
