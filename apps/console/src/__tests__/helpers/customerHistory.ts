import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CustomerHistoryErrorResponse,
  CustomerSearchRequest,
  CustomerSearchResponse,
  CustomerTimelinePage,
  CustomerTimelineRequest,
} from '@magick-agency/contracts/api/agency/customer-history';

/**
 * The contract's customer-history fixtures (`packages/contracts/fixtures/agent/`),
 * read from disk so the console's tests run against the same sample answer and the
 * same number table as the server, the domain rule and the agent app.
 */

const FIXTURES = resolve(__dirname, '../../../../../packages/contracts/fixtures/agent');

export interface CustomerHistoryFixture {
  search_request: CustomerSearchRequest;
  search_response: CustomerSearchResponse;
  search_response_empty: CustomerSearchResponse;
  timeline_request: CustomerTimelineRequest;
  timeline_page_last: CustomerTimelinePage;
  error_invalid_number: CustomerHistoryErrorResponse;
  error_search_expired: CustomerHistoryErrorResponse;
}

export type CustomerSearchNumberCase =
  | { input: string; country: string; e164: string; formatted: string; countryIso: string | null }
  | { input: string; country: string; error: string; message: string };

/** A fresh deep copy on every call, so a test that edits it cannot leak into the next. */
export function customerHistoryFixture(): CustomerHistoryFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, 'customer-history.json'), 'utf-8')) as CustomerHistoryFixture;
}

export function customerSearchNumberCases(): CustomerSearchNumberCase[] {
  const table = JSON.parse(readFileSync(resolve(FIXTURES, 'customer-search-numbers.json'), 'utf-8')) as {
    cases: CustomerSearchNumberCase[];
  };
  return table.cases;
}
